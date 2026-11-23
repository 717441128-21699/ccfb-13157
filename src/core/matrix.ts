// 3x3 矩阵工具（行主序，长度 9 的扁平数组），用于颜色校正

export type Mat3 = number[];

export function identity3(): Mat3 {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

export function multiply3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3] * b[c] +
        a[r * 3 + 1] * b[3 + c] +
        a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

export function mat3Vec(m: Mat3, v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/**
 * 最小二乘求 3x3 颜色变换矩阵 M，使 M · measured_i ≈ target_i（均为线性 RGB 列向量）。
 * 按通道独立求解：对每个输出通道 r，求行向量 m_r 使 m_r · X = Y_r（X 为 3xN 测量矩阵）。
 * 正规方程 m_r = Y_r X^T (X X^T)^-1，加岭回归阻尼保证稳定。
 */
export function fitColorMatrix(
  measured: [number, number, number][],
  target: [number, number, number][],
  ridge = 1e-4,
): { matrix: Mat3; rmse: number } {
  const n = measured.length;
  // XtX = X X^T (3x3), XtY (3x3: 行=测量通道, 列=目标通道)
  const xtx = new Array(9).fill(0);
  const xty = new Array(9).fill(0);
  for (let i = 0; i < n; i++) {
    const x = measured[i];
    const y = target[i];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        xtx[r * 3 + c] += x[r] * x[c];
        xty[r * 3 + c] += x[r] * y[c];
      }
    }
  }
  // 岭阻尼
  for (let i = 0; i < 3; i++) xtx[i * 3 + i] += ridge;

  const inv = invert3(xtx);
  if (!inv) {
    return { matrix: identity3(), rmse: Infinity };
  }
  // M^T = inv * XtY，再转置得到行主序 M
  const mt = multiply3(inv, xty);
  const m = identity3();
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      m[r * 3 + c] = mt[c * 3 + r];
    }
  }

  let sse = 0;
  for (let i = 0; i < n; i++) {
    const [r, g, b] = mat3Vec(m, measured[i]);
    const t = target[i];
    sse += (r - t[0]) ** 2 + (g - t[1]) ** 2 + (b - t[2]) ** 2;
  }
  return { matrix: m, rmse: Math.sqrt(sse / (n * 3)) };
}

export function invert3(m: Mat3): Mat3 | null {
  const a = m[0], b = m[1], c = m[2];
  const d = m[3], e = m[4], f = m[5];
  const g = m[6], h = m[7], i = m[8];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  return [
    A * invDet,
    (c * h - b * i) * invDet,
    (b * f - c * e) * invDet,
    B * invDet,
    (a * i - c * g) * invDet,
    (c * d - a * f) * invDet,
    C * invDet,
    (b * g - a * h) * invDet,
    (a * e - b * d) * invDet,
  ];
}

/**
 * 亮度归一化：求标量 k 使 k·sum(Y_lin_measured) ≈ sum(Y_lin_target)，
 * 用于分离曝光增益与色度矩阵，避免矩阵承担过大的对角增益。
 */
export function fitExposure(measured: number[][], target: number[][]): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < measured.length; i++) {
    const ym = 0.2126 * measured[i][0] + 0.7152 * measured[i][1] + 0.0722 * measured[i][2];
    const yt = 0.2126 * target[i][0] + 0.7152 * target[i][1] + 0.0722 * target[i][2];
    num += yt * ym;
    den += ym * ym;
  }
  return den > 1e-9 ? num / den : 1;
}
