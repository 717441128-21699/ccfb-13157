import { describe, it, expect } from 'vitest';
import { srgbToLinear, linearToSrgb, rgbToLab, deltaE, rgbDeltaE } from '../src/core/color';

describe('颜色空间转换', () => {
  it('sRGB 线性化往返一致', () => {
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      expect(linearToSrgb(srgbToLinear(v * 255))).toBeCloseTo(v * 255, -1);
    }
  });

  it('黑色 Lab 接近原点', () => {
    const lab = rgbToLab({ r: 0, g: 0, b: 0 });
    expect(lab.L).toBeCloseTo(0, 1);
  });

  it('D65 白色 Lab 接近 (100,0,0)', () => {
    const lab = rgbToLab({ r: 255, g: 255, b: 255 });
    expect(lab.L).toBeCloseTo(100, 0);
    expect(Math.abs(lab.a)).toBeLessThan(1);
    expect(Math.abs(lab.b)).toBeLessThan(1);
  });

  it('红色 a* 显著为正、蓝色 b* 显著为负', () => {
    const red = rgbToLab({ r: 220, g: 40, b: 40 });
    const blue = rgbToLab({ r: 40, g: 60, b: 220 });
    expect(red.a).toBeGreaterThan(30);
    expect(blue.b).toBeLessThan(-20);
  });

  it('相同颜色 ΔE 为 0，不同颜色 ΔE > 0', () => {
    const c = { r: 120, g: 90, b: 80 };
    expect(deltaE(rgbToLab(c), rgbToLab(c))).toBeCloseTo(0, 5);
    expect(rgbDeltaE({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 })).toBeGreaterThan(80);
  });
});
