import { describe, it, expect } from 'vitest';
import { fitColorMatrix, fitExposure, invert3 } from '../src/core/matrix';

describe('3x3 矩阵', () => {
  it('单位矩阵求逆仍为单位矩阵', () => {
    const inv = invert3([1, 0, 0, 0, 1, 0, 0, 0, 1])!;
    expect(inv).toHaveLength(9);
    inv.forEach((v, i) => expect(v).toBeCloseTo(i % 4 === 0 ? 1 : 0, 6));
  });

  it('对角矩阵求逆正确', () => {
    const inv = invert3([2, 0, 0, 0, 4, 0, 0, 0, 8])!;
    expect(inv[0]).toBeCloseTo(0.5, 6);
    expect(inv[4]).toBeCloseTo(0.25, 6);
    expect(inv[8]).toBeCloseTo(0.125, 6);
  });
});

describe('颜色变换拟合', () => {
  it('恒等映射下矩阵接近单位阵、残差很小', () => {
    // 构造若干线性 RGB 样本，目标=输入
    const data: [number, number, number][] = [
      [0.2, 0.1, 0.05], [0.8, 0.3, 0.2], [0.5, 0.9, 0.1],
      [0.1, 0.4, 0.7], [0.6, 0.6, 0.6], [0.9, 0.7, 0.85],
      [0.3, 0.55, 0.25], [0.7, 0.2, 0.9],
    ];
    const { matrix, rmse } = fitColorMatrix(data, data, 0.001);
    expect(rmse).toBeLessThan(0.02);
    expect(matrix[0]).toBeCloseTo(1, 1);
    expect(matrix[4]).toBeCloseTo(1, 1);
    expect(matrix[8]).toBeCloseTo(1, 1);
  });

  it('能反演已知的对角增益（光源校正场景）', () => {
    // 测量值 = 目标值经过通道增益
    const gain: [number, number, number] = [1.25, 1.0, 0.6];
    const target: [number, number, number][] = [
      [0.3, 0.4, 0.5], [0.8, 0.2, 0.6], [0.5, 0.7, 0.3],
      [0.2, 0.9, 0.8], [0.6, 0.6, 0.4], [0.9, 0.5, 0.7],
    ];
    const measured = target.map(([r, g, b]) => [r * gain[0], g * gain[1], b * gain[2]] as [number, number, number]);
    const { matrix, rmse } = fitColorMatrix(measured, target, 0.001);
    expect(rmse).toBeLessThan(0.03);
    // 校正后第一个通道应被压低（抵消 1.25 增益）
    expect(matrix[0]).toBeLessThan(1);
    expect(matrix[8]).toBeGreaterThan(1); // 蓝通道补偿 1/0.6
  });

  it('曝光增益拟合接近亮度比', () => {
    const measured: [number, number, number][] = [[0.4, 0.3, 0.2], [0.8, 0.6, 0.4]];
    const target: [number, number, number][] = [[0.2, 0.15, 0.1], [0.4, 0.3, 0.2]];
    const k = fitExposure(measured, target);
    expect(k).toBeCloseTo(0.5, 1);
  });
});
