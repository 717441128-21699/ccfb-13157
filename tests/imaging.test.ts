import { describe, it, expect } from 'vitest';
import { connectedComponents, largestComponentMask } from '../src/core/imaging';

describe('连通域分析', () => {
  it('能分离两个不相邻的方块', () => {
    // 10x10，左上 2x2 与右下 2x2
    const mask = new Uint8Array(100);
    const set = (x: number, y: number): void => {
      mask[y * 10 + x] = 255;
    };
    [[0, 0], [1, 0], [0, 1], [1, 1], [8, 8], [9, 8], [8, 9], [9, 9]].forEach(([x, y]) => set(x, y));
    const comps = connectedComponents(mask, 10, 10);
    expect(comps).toHaveLength(2);
    expect(comps[0].pixels).toHaveLength(4);
    expect(comps[1].pixels).toHaveLength(4);
  });

  it('4-邻接下对角方块不算连通', () => {
    const mask = new Uint8Array(25);
    mask[0] = 255; // (0,0)
    mask[6] = 255; // (1,1) 仅对角
    expect(connectedComponents(mask, 5, 5)).toHaveLength(2);
  });

  it('largestComponentMask 只保留最大块', () => {
    const mask = new Uint8Array(100);
    for (let i = 0; i < 3; i++) mask[i] = 255; // 3 像素
    for (let i = 90; i < 95; i++) mask[i] = 255; // 5 像素
    const { mask: out, comp } = largestComponentMask(mask, 10, 10);
    expect(comp?.pixels).toHaveLength(5);
    expect(out.reduce((s, v) => s + (v ? 1 : 0), 0)).toBe(5);
  });
});
