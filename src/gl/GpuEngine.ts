// WebGL2 计算引擎：管理纹理、帧缓冲与全屏着色器管线。
// 所有逐像素计算（校色、Lab、概率图、形态学、反光修复、裂纹）都在 GPU 完成。

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2((aPos.x + 1.0) * 0.5, (aPos.y + 1.0) * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// 共享 GLSL 函数
const GLSL_COMMON = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

// GLSL ES 3.00 无 cbrt，用 sign 保证负数也可开立方
float cbrt1(float x) { return sign(x) * pow(abs(x), 1.0 / 3.0); }
vec3 cbrt3(vec3 x) { return vec3(cbrt1(x.x), cbrt1(x.y), cbrt1(x.z)); }
// 逐分量三元选择（mix 要求两个参数同维）
vec3 select3(vec3 a, vec3 b, vec3 cond) {
  return vec3(cond.x > 0.5 ? b.x : a.x, cond.y > 0.5 ? b.y : a.y, cond.z > 0.5 ? b.z : a.z);
}
vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return select3(lo, hi, step(vec3(0.04045), c));
}
vec3 linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return select3(lo, hi, step(vec3(0.0031308), c));
}
vec3 linRgbToXyz(vec3 c) {
  return mat3(0.4124564, 0.2126729, 0.0193339,
              0.3575761, 0.7151522, 0.119192,
              0.1804375, 0.0721750, 0.9503041) * c;
}
vec3 xyzToLab(vec3 xyz) {
  vec3 n = xyz / vec3(0.95047, 1.0, 1.08883);
  vec3 lo = n / (3.0 * 0.205137 * 0.205137) + 4.0 / 29.0;
  vec3 hi = cbrt3(n);
  vec3 f = select3(lo, hi, step(vec3(0.008856), n));
  return vec3(116.0 * f.y - 16.0, 500.0 * (f.x - f.y), 200.0 * (f.y - f.z));
}
vec3 srgbToLab(vec3 srgb) {
  return xyzToLab(linRgbToXyz(srgbToLinear(srgb)));
}
float lumaLin(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}`;

export interface GpuTexture {
  tex: WebGLTexture;
  w: number;
  h: number;
  internal: number;
  format: number;
  type: number;
  /** 内容语义：lab=Lab+亮度（用量程编码），unit=0~1 概率/掩码，srgb=颜色 */
  semantic?: 'lab' | 'unit' | 'srgb';
}

interface ProgramInfo {
  prog: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
  uniformTypes: Map<string, number>;
}

export class GpuEngine {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  private floatRenderable = false;
  private programs = new Map<string, ProgramInfo>();
  private vao: WebGLVertexArrayObject;
  private quadBuffer: WebGLBuffer;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      preserveDrawingBuffer: false,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error('当前环境不支持 WebGL2');
    this.gl = gl;
    this.canvas = canvas;
    const ext = gl.getExtension('EXT_color_buffer_float');
    this.floatRenderable = !!ext;
    gl.getExtension('OES_texture_float_linear');

    this.quadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  get supportsFloat(): boolean {
    return this.floatRenderable;
  }

  private compile(fragSrc: string): ProgramInfo {
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, VERT);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, fragSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(fs);
      throw new Error('片元着色器编译失败: ' + log + '\n' + fragSrc);
    }
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(prog));
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    const uniforms = new Map<string, WebGLUniformLocation | null>();
    const uniformTypes = new Map<string, number>();
    const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(prog, i)!;
      const name = info.name.endsWith('[0]') ? info.name.slice(0, -3) : info.name;
      uniforms.set(name, gl.getUniformLocation(prog, name));
      uniformTypes.set(name, info.type);
    }
    return { prog, uniforms, uniformTypes };
  }

  private getProgram(fragSrc: string): ProgramInfo {
    let p = this.programs.get(fragSrc);
    if (!p) {
      p = this.compile(fragSrc);
      this.programs.set(fragSrc, p);
    }
    return p;
  }

  /** 创建浮点纹理（不可渲染时回退 RGBA8 归一化） */
  createTexture(w: number, h: number, kind: 'rgba16f' | 'r8' | 'rgba8' | 'r16f', semantic: GpuTexture['semantic'] = 'unit'): GpuTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    let internal: number, format: number, type: number;
    if (kind === 'rgba16f') {
      if (this.floatRenderable) {
        internal = gl.RGBA16F; format = gl.RGBA; type = gl.FLOAT;
      } else {
        internal = gl.RGBA8; format = gl.RGBA; type = gl.UNSIGNED_BYTE;
      }
    } else if (kind === 'r16f') {
      if (this.floatRenderable) {
        internal = gl.R16F; format = gl.RED; type = gl.FLOAT;
      } else {
        internal = gl.R8; format = gl.RED; type = gl.UNSIGNED_BYTE;
      }
    } else if (kind === 'r8') {
      internal = gl.R8; format = gl.RED; type = gl.UNSIGNED_BYTE;
    } else {
      internal = gl.RGBA8; format = gl.RGBA; type = gl.UNSIGNED_BYTE;
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, w, h, internal, format, type, semantic };
  }

  uploadImage(img: ImageBitmap | HTMLCanvasElement): GpuTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // 翻转 Y：使 GPU 的 vUv 坐标与 CPU ImageData 的顶左原点一致，
    // 这样 CPU 回读的掩码索引与 GPU 采样坐标完全对应。
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img as unknown as TexImageSource);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, w: (img as ImageBitmap).width || (img as HTMLCanvasElement).width, h: (img as ImageBitmap).height || (img as HTMLCanvasElement).height, internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
  }

  private framebuffer: WebGLFramebuffer | null = null;

  private bindTargets(targets: GpuTexture[]): void {
    const gl = this.gl;
    if (!this.framebuffer) this.framebuffer = gl.createFramebuffer();
    // 附加前清空所有纹理单元，避免目标纹理仍被采样绑定而形成反馈环
    for (let u = 0; u < 8; u++) {
      gl.activeTexture(gl.TEXTURE0 + u);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    const bufs: number[] = [];
    targets.forEach((t, i) => {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t.tex, 0);
      bufs.push(gl.COLOR_ATTACHMENT0 + i);
    });
    gl.drawBuffers(bufs);
    gl.viewport(0, 0, targets[0].w, targets[0].h);
  }

  private setUniform(p: ProgramInfo, name: string, value: number | number[] | GpuTexture | null, unit: number): void {
    const gl = this.gl;
    const loc = p.uniforms.get(name);
    if (loc == null) return;
    if (value === null) return;
    if (typeof value === 'number') {
      const t = p.uniformTypes.get(name);
      if (t === gl.INT || t === gl.BOOL) {
        gl.uniform1i(loc, value | 0);
      } else {
        gl.uniform1f(loc, value);
      }
    } else if (Array.isArray(value)) {
      if (value.length === 9) gl.uniformMatrix3fv(loc, false, new Float32Array(value));
      else if (value.length === 4) gl.uniform4fv(loc, new Float32Array(value));
      else if (value.length === 3) gl.uniform3fv(loc, new Float32Array(value));
      else if (value.length === 2) gl.uniform2fv(loc, new Float32Array(value));
      else gl.uniform1fv(loc, new Float32Array(value));
    } else {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, value.tex);
      gl.uniform1i(loc, unit);
    }
  }

  /** 执行一次全屏渲染 */
  run(fragSrc: string, targets: GpuTexture[], uniforms: Record<string, number | number[] | GpuTexture> = {}): void {
    const gl = this.gl;
    const p = this.getProgram(fragSrc);
    this.bindTargets(targets);
    // 检查帧缓冲完整性
    const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (fbStatus !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`帧缓冲不完整 status=0x${fbStatus.toString(16)} float=${this.floatRenderable}`);
    }
    gl.useProgram(p.prog);
    gl.bindVertexArray(this.vao);
    // 先解绑所有纹理单元，杜绝“采样纹理==渲染目标”的反馈环
    for (let u = 0; u < 8; u++) {
      gl.activeTexture(gl.TEXTURE0 + u);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    let unit = 0;
    for (const [k, v] of Object.entries(uniforms)) {
      this.setUniform(p, k, v, unit);
      if (typeof v === 'object' && !Array.isArray(v)) unit++;
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * 回读纹理。RGBA16F 不能直接 readPixels 成 FLOAT（WebGL2 规范限制），
   * 因此对浮点纹理先绘制到 RGBA8 中转纹理（Lab/亮度按已知量程归一化编码），
   * 再读字节。返回值对浮点纹理仍给出 Float32Array（已解码）。
   */
  readPixels(tex: GpuTexture): Float32Array | Uint8Array {
    const gl = this.gl;
    const channels = tex.format === gl.RED ? 1 : 4;

    if (tex.type === gl.FLOAT) {
      const isR = tex.format === gl.RED;
      const tmp = this.createTexture(tex.w, tex.h, 'rgba8');
      this.encodeForReadback(tex, tmp, isR);
      const bytes = new Uint8Array(tex.w * tex.h * 4);
      this.bindTargets([tmp]);
      gl.readPixels(0, 0, tex.w, tex.h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      this.destroyTexture(tmp);
      const out = new Float32Array(tex.w * tex.h * channels);
      const labMode = tex.semantic === 'lab';
      for (let i = 0; i < tex.w * tex.h; i++) {
        if (isR) {
          out[i] = bytes[i * 4] / 255;
        } else if (labMode) {
          // Lab 纹理：L/100, (a+60)/120, (b+60)/120, luma/1.5
          out[i * 4] = (bytes[i * 4] / 255) * 100;
          out[i * 4 + 1] = (bytes[i * 4 + 1] / 255) * 120 - 60;
          out[i * 4 + 2] = (bytes[i * 4 + 2] / 255) * 120 - 60;
          out[i * 4 + 3] = (bytes[i * 4 + 3] / 255) * 1.5;
        } else {
          // unit/srgb 纹理：各通道本就是 0~1
          out[i * 4] = bytes[i * 4] / 255;
          out[i * 4 + 1] = bytes[i * 4 + 1] / 255;
          out[i * 4 + 2] = bytes[i * 4 + 2] / 255;
          out[i * 4 + 3] = bytes[i * 4 + 3] / 255;
        }
      }
      return out;
    }

    this.bindTargets([tex]);
    const buf = new Uint8Array(tex.w * tex.h * channels);
    gl.readPixels(0, 0, tex.w, tex.h, tex.format, tex.type, buf);
    const err = gl.getError();
    if (err !== gl.NO_ERROR && tex.format === gl.RED) {
      const fb = new Uint8Array(tex.w * tex.h * 4);
      gl.readPixels(0, 0, tex.w, tex.h, gl.RGBA, gl.UNSIGNED_BYTE, fb);
      for (let i = 0; i < buf.length; i++) buf[i] = fb[i * 4];
    }
    return buf;
  }

  /** 把浮点纹理编码进 RGBA8 以便回读（确保输入与输出是不同纹理） */
  private encodeForReadback(src: GpuTexture, dst: GpuTexture, isR: boolean): void {
    if (src.tex === dst.tex) throw new Error('回读编码的输入输出不能是同一纹理');
    const labMode = src.semantic === 'lab';
    const frag = `#version 300 es
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D uInput;
uniform int uIsR;
uniform int uLab;
void main() {
  vec4 v = texture(uInput, vUv);
  if (uIsR == 1) {
    outColor = vec4(clamp(v.r, 0.0, 1.0), 0.0, 0.0, 1.0);
  } else if (uLab == 1) {
    outColor = vec4(
      clamp(v.r / 100.0, 0.0, 1.0),
      clamp((v.g + 60.0) / 120.0, 0.0, 1.0),
      clamp((v.b + 60.0) / 120.0, 0.0, 1.0),
      clamp(v.a / 1.5, 0.0, 1.0)
    );
  } else {
    outColor = clamp(v, 0.0, 1.0);
  }
}`;
    this.run(frag, [dst], { uInput: src, uIsR: isR ? 1 : 0, uLab: labMode ? 1 : 0 });
  }

  uploadMask(tex: GpuTexture, data: Uint8Array): void {
    const gl = this.gl;
    // 先解绑帧缓冲，避免对绑定中的渲染目标做 texSubImage 形成反馈环
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, tex.w, tex.h, tex.format, tex.type, data);
  }

  destroyTexture(t: GpuTexture): void {
    this.gl.deleteTexture(t.tex);
  }

  // ---------------- 着色器源码 ----------------

  /** 色卡校色：线性化 -> 曝光增益 -> 3x3 矩阵 -> sRGB 编码 */
  static readonly FS_CALIBRATE = GLSL_COMMON + `
  uniform sampler2D uInput;
  uniform mat3 uMatrix;
  uniform float uExposure;
  void main() {
    vec3 srgb = texture(uInput, vUv).rgb;
    vec3 lin = srgbToLinear(srgb);
    vec3 corr = uMatrix * (lin * uExposure);
    outColor = vec4(linearToSrgb(corr), 1.0);
  }`;

  /** 无校色时的直通（仍输出标准 sRGB） */
  static readonly FS_PASSTHROUGH = GLSL_COMMON + `
  uniform sampler2D uInput;
  void main() { outColor = texture(uInput, vUv); }`;

  /**
   * 概率图 + Lab（MRT 双目标，一次绘制同时输出）：
   * target0 = (pTongue, pCoating, pSpecular, pLipOrTeeth)
   * target1 = (L, a, b, linearLuma)
   * 基于校色后 sRGB 的 Lab 特征 + 中心先验。
   */
  /** Lab 颜色转换公共 GLSL（供概率图与 Lab 着色器共享，避免 MRT 兼容问题） */
  static readonly GLSL_LIB = `
vec3 srgbToLinear2(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  vec3 cond = step(vec3(0.04045), c);
  return vec3(cond.x > 0.5 ? hi.x : lo.x, cond.y > 0.5 ? hi.y : lo.y, cond.z > 0.5 ? hi.z : lo.z);
}
vec3 linRgbToXyz2(vec3 c) {
  return mat3(0.4124564, 0.2126729, 0.0193339,
              0.3575761, 0.7151522, 0.119192,
              0.1804375, 0.0721750, 0.9503041) * c;
}
float cbrt1f(float x) { return sign(x) * pow(abs(x), 1.0 / 3.0); }
vec3 cbrt3f(vec3 x) { return vec3(cbrt1f(x.x), cbrt1f(x.y), cbrt1f(x.z)); }
vec3 xyzToLab2(vec3 xyz) {
  vec3 n = xyz / vec3(0.95047, 1.0, 1.08883);
  vec3 lo = n / (3.0 * 0.205137 * 0.205137) + 4.0 / 29.0;
  vec3 hi = cbrt3f(n);
  vec3 cond = step(vec3(0.008856), n);
  vec3 f = vec3(cond.x > 0.5 ? hi.x : lo.x, cond.y > 0.5 ? hi.y : lo.y, cond.z > 0.5 ? hi.z : lo.z);
  return vec3(116.0 * f.y - 16.0, 500.0 * (f.x - f.y), 200.0 * (f.y - f.z));
}
float lumaLin2(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float smoothBand(float x, float lo, float hi) {
  return smoothstep(lo, lo + (hi - lo) * 0.5, x) * (1.0 - smoothstep(hi - (hi - lo) * 0.5, hi, x));
}`;

  /**
   * 概率图（单目标）：(pTongue, pCoating, pSpecular, pLipOrTeeth)
   * 基于校色后 sRGB 的 Lab 特征 + 中心先验。Lab 由独立的 FS_LAB 另出一遍。
   */
  static readonly FS_PROB = `#version 300 es
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outProb;
uniform sampler2D uInput;
uniform vec2 uCenter;
uniform vec2 uAxis;
uniform vec2 uTexel;
${GpuEngine.GLSL_LIB}
void main() {
  vec3 srgb = texture(uInput, vUv).rgb;
  vec3 lin = srgbToLinear2(srgb);
  vec3 lab = xyzToLab2(linRgbToXyz2(lin));
  float L = lab.x, a = lab.y, b = lab.z;
  float lum = lumaLin2(lin);

  vec2 d = (vUv - uCenter) / uAxis;
  float radial = 1.0 - clamp(length(d), 0.0, 1.0);
  float centerPrior = smoothstep(0.0, 0.35, radial);

  // 舌体：红度 + 中心先验 + 排除牙齿/嘴唇/皮肤。
  // 不使用亮度门限——舌苔高亮时 L 很高，若用 Lband 会把舌苔误排除出舌体。
  // 红度门槛放宽，暖光/荧光灯下舌体 a* 被冲淡到 10 左右仍能纳入
  float redness = smoothstep(2.0, 11.0, a);
  float pTeeth = smoothstep(80.0, 88.0, L) * (1.0 - smoothstep(3.0, 9.0, a));
  float pLip = smoothstep(26.0, 33.0, a) * (1.0 - smoothstep(40.0, 50.0, L));
  float pSkin = (1.0 - smoothstep(7.0, 13.0, a)) * smoothstep(64.0, 74.0, L);

  // 中心先验强的区域（舌体所在），皮肤判据应被大幅削弱——舌苔同样高亮低红但位于中心
  float centerWeight = smoothstep(0.15, 0.5, radial);
  float skinSuppression = 1.0 - pSkin * (1.0 - centerWeight * 0.75) * 0.85;
  float pTongue = redness * centerPrior * (1.0 - pTeeth * 0.9) * (1.0 - pLip * 0.85) * skinSuppression;
  // 中心高亮低红区域（舌苔）也纳入舌体，避免苔被排除
  float centerBright = centerWeight * smoothstep(56.0, 66.0, L) * (1.0 - smoothstep(18.0, 26.0, a));
  pTongue = clamp(max(pTongue, centerBright * 0.8), 0.0, 1.0);
  float tongueGate = smoothstep(0.3, 0.55, pTongue);

  // 舌苔：比周围舌面更亮、红度更低（都用相对量，深舌上的厚白苔混合后 a* 仍偏高也能检出）
  float localL = 0.0;
  float localA = 0.0;
  float localN = 0.0;
  for (int yy = -3; yy <= 3; yy++) {
    for (int xx = -3; xx <= 3; xx++) {
      vec2 off = vec2(float(xx), float(yy)) * uTexel;
      vec3 nLab = xyzToLab2(linRgbToXyz2(srgbToLinear2(texture(uInput, vUv + off).rgb)));
      localL += nLab.x;
      localA += nLab.y;
      localN += 1.0;
    }
  }
  localL /= max(1.0, localN);
  localA /= max(1.0, localN);
  // 比局部亮，或本身就很亮；红度比局部低
  float relBright = smoothstep(1.5, 7.0, L - localL);
  float absBright = smoothstep(58.0, 68.0, L);
  float coatLight = max(relBright, absBright * 0.7);
  float coatLowA = smoothstep(1.0, 7.0, localA - a) + (1.0 - smoothstep(16.0, 23.0, a)) * 0.5;
  coatLowA = clamp(coatLowA, 0.0, 1.0);
  float pCoat = clamp(coatLight * coatLowA * tongueGate, 0.0, 1.0);

  float sat = max(lin.r, max(lin.g, lin.b)) - min(lin.r, min(lin.g, lin.b));
  float pSpec = smoothstep(0.78, 0.9, lum) * (1.0 - smoothstep(0.08, 0.18, sat));
  pSpec *= tongueGate;

  float pLipTeeth = max(pLip, pTeeth);
  outProb = vec4(clamp(pTongue, 0.0, 1.0), clamp(pCoat, 0.0, 1.0),
                 clamp(pSpec, 0.0, 1.0), clamp(pLipTeeth, 0.0, 1.0));
}`;

  /** Lab 单目标着色器：(L, a, b, linearLuma)，独立一遍渲染，规避 MRT 兼容问题 */
  static readonly FS_LAB = `#version 300 es
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outLab;
uniform sampler2D uInput;
${GpuEngine.GLSL_LIB}
void main() {
  vec3 srgb = texture(uInput, vUv).rgb;
  vec3 lin = srgbToLinear2(srgb);
  vec3 lab = xyzToLab2(linRgbToXyz2(lin));
  outLab = vec4(lab, lumaLin2(lin));
}`;

  /** 阈值化：probe 通道 > t 输出 255 */
  static readonly FS_THRESHOLD = GLSL_COMMON + `
  uniform sampler2D uInput;
  uniform float uThreshold;
  uniform int uChannel; // 0=R 1=G 2=B 3=A
  void main() {
    vec4 c = texture(uInput, vUv);
    float v = uChannel == 0 ? c.r : uChannel == 1 ? c.g : uChannel == 2 ? c.b : c.a;
    outColor = vec4(vec3(step(uThreshold, v)), 1.0);
  }`;

  /**
   * 舌苔增强着色器：在舌区内综合亮度、低红度与局部粗糙度。
   * 输出 R=苔概率（厚/腻苔粗糙度更高），G=局部 L 标准差（粗糙度），B=黄度(b*)，A=亮度 L。
   * 粗糙度用 5x5 邻域 L 的标准差衡量——厚苔颗粒感强、薄苔平滑。
   */
  static readonly FS_COAT = `#version 300 es
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outCoat;
uniform sampler2D uLab;
uniform sampler2D uTongue;
uniform vec2 uTexel;
${GpuEngine.GLSL_LIB}
void main() {
  float tongue = texture(uTongue, vUv).r;
  if (tongue < 0.5) { outCoat = vec4(0.0); return; }
  vec4 here = texture(uLab, vUv);
  float L = here.r;
  float a = here.g;
  float b = here.b;

  // 5x5 局部 L 均值与标准差
  float sum = 0.0;
  float sumSq = 0.0;
  float n = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 off = vec2(float(x), float(y)) * uTexel;
      if (texture(uTongue, vUv + off).r > 0.5) {
        float lx = texture(uLab, vUv + off).r;
        sum += lx;
        sumSq += lx * lx;
        n += 1.0;
      }
    }
  }
  float mean = sum / max(1.0, n);
  float variance = max(0.0, sumSq / max(1.0, n) - mean * mean);
  float roughness = sqrt(variance);

  // 舌苔相对特征：比周围舌面更亮（局部对比）且红度更低。
  // 用相对亮度而非绝对 L，深舌上的厚白苔也能检出。
  float relBright = smoothstep(2.0, 8.0, L - mean);
  float absBright = smoothstep(58.0, 68.0, L);
  float bright = max(relBright, absBright * 0.7);
  float lowA = 1.0 - smoothstep(17.0, 25.0, a);
  float pCoat = clamp(bright * lowA, 0.0, 1.0);
  // 归一化输出便于回读：R=苔概率 G=粗糙度/20 B=(b*+20)/80 A=L/100
  outCoat = vec4(pCoat, clamp(roughness / 20.0, 0.0, 1.0), clamp((b + 20.0) / 80.0, 0.0, 1.0), clamp(L / 100.0, 0.0, 1.0));
}`;

  /** 可分离形态学：uDir=(1/w,0) 水平 / (0,1/h) 垂直；erode 取最小，dilate 取最大 */
  static readonly FS_MORPH = GLSL_COMMON + `
  uniform sampler2D uInput;
  uniform vec2 uDir;
  uniform int uRadius;
  uniform int uOp; // 0=erode 1=dilate
  void main() {
    float best = uOp == 1 ? 0.0 : 1.0;
    for (int i = -8; i <= 8; i++) {
      if (i > -uRadius && i < uRadius) {
        float v = texture(uInput, vUv + uDir * float(i)).r;
        best = uOp == 1 ? max(best, v) : min(best, v);
      }
    }
    outColor = vec4(vec3(best), 1.0);
  }`;

  /**
   * 反光修复（掩码模糊填充）：spec 掩码处用邻域非反光舌面 Lab 替代，迭代两次。
   * 输入 uLab（RGBA16F），uMask（R=tongue, B=spec）
   */
  static readonly FS_INPAINT = GLSL_COMMON + `
  uniform sampler2D uLab;
  uniform sampler2D uMask;
  uniform vec2 uTexel;
  void main() {
    vec4 m = texture(uMask, vUv);
    vec4 cur = texture(uLab, vUv);
    if (m.b < 0.5) { outColor = cur; return; }
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int y = -3; y <= 3; y++) {
      for (int x = -3; x <= 3; x++) {
        vec2 off = vec2(float(x), float(y)) * uTexel;
        vec4 mm = texture(uMask, vUv + off);
        if (mm.r > 0.5 && mm.b < 0.5) {
          float w = 1.0 / (1.0 + float(x * x + y * y));
          acc += texture(uLab, vUv + off).rgb * w;
          wsum += w;
        }
      }
    }
    if (wsum > 0.0) outColor = vec4(acc / wsum, cur.a);
    else outColor = cur;
  }`;

  /**
   * 裂纹检测：舌体（非舌苔、非反光）内，局部 L 均值明显低于周围的暗细线。
   * 输出 R=crack 掩码
   */
  static readonly FS_CRACK = GLSL_COMMON + `
  uniform sampler2D uLab;
  uniform sampler2D uMask;
  uniform vec2 uTexel;
  void main() {
    vec4 m = texture(uMask, vUv);
    if (m.r < 0.5 || m.g > 0.5 || m.b > 0.5) { outColor = vec4(0.0); return; }
    float L = texture(uLab, vUv).r;
    float mean = 0.0;
    float wsum = 0.0;
    for (int y = -4; y <= 4; y++) {
      for (int x = -4; x <= 4; x++) {
        if (x == 0 && y == 0) continue;
        vec2 off = vec2(float(x), float(y)) * uTexel;
        vec4 mm = texture(uMask, vUv + off);
        if (mm.r > 0.5 && mm.g < 0.5 && mm.b < 0.5) {
          mean += texture(uLab, vUv + off).r;
          wsum += 1.0;
        }
      }
    }
    if (wsum < 8.0) { outColor = vec4(0.0); return; }
    mean /= wsum;
    float score = mean - L; // 正值表示比周围暗
    // 双侧连续暗线：水平或垂直方向上两个邻居都比当前点暗，
    // 颗粒噪声不具备这种方向性连续，可显著降低假阳性
    float nxL = texture(uLab, vUv - vec2(uTexel.x * 2.0, 0.0)).r;
    float nxR = texture(uLab, vUv + vec2(uTexel.x * 2.0, 0.0)).r;
    float nyU = texture(uLab, vUv - vec2(0.0, uTexel.y * 2.0)).r;
    float nyD = texture(uLab, vUv + vec2(0.0, uTexel.y * 2.0)).r;
    float lineX = step(L + 1.5, nxL) * step(L + 1.5, nxR);
    float lineY = step(L + 1.5, nyU) * step(L + 1.5, nyD);
    float lineLike = max(lineX, lineY);
    float crack = step(9.8, score) * lineLike;
    outColor = vec4(vec3(crack), 1.0);
  }`;

  /** 打包最终掩码：R=tongue G=coating B=spec A=crack */
  static readonly FS_PACK = GLSL_COMMON + `
  uniform sampler2D uTongue;
  uniform sampler2D uCoat;
  uniform sampler2D uSpec;
  uniform sampler2D uCrack;
  void main() {
    float t = texture(uTongue, vUv).r;
    float c = texture(uCoat, vUv).r * step(0.5, t);
    float s = texture(uSpec, vUv).r * step(0.5, t);
    float k = texture(uCrack, vUv).r * step(0.5, t) * step(0.5, 1.0 - c);
    outColor = vec4(step(0.5, t), step(0.5, c), step(0.5, s), step(0.5, k));
  }`;
}
