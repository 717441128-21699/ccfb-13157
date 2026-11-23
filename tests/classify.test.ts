import { describe, it, expect } from 'vitest';
import { classifyTongueColor, classifyCoating } from '../src/core/classify';
import { TONGUE_COLOR_PROTOTYPES, COATING_PROTOTYPES } from '../src/core/references';

describe('舌色分类', () => {
  it('每个原型点都应被分到自身类别', () => {
    for (const [cls, proto] of Object.entries(TONGUE_COLOR_PROTOTYPES)) {
      const r = classifyTongueColor(proto.lab);
      expect(r.cls).toBe(cls);
    }
  });

  it('淡白与绛在亮度上可分', () => {
    const pale = classifyTongueColor(TONGUE_COLOR_PROTOTYPES.pale.lab);
    const deep = classifyTongueColor(TONGUE_COLOR_PROTOTYPES.deepRed.lab);
    expect(pale.cls).toBe('pale');
    expect(deep.cls).toBe('deepRed');
  });

  it('返回全部五类的距离且命中类距离最小', () => {
    const r = classifyTongueColor(TONGUE_COLOR_PROTOTYPES.red.lab);
    expect(Object.keys(r.distances)).toHaveLength(5);
    expect(r.distances.red).toBeLessThan(r.distances.pale);
  });
});

describe('舌苔分类', () => {
  it('高黄度判黄腻', () => {
    const r = classifyCoating(0.4, COATING_PROTOTYPES.greasyYellow.lab, 5, 26);
    expect(r.cls).toBe('greasyYellow');
  });

  it('低覆盖低黄度判薄白', () => {
    const r = classifyCoating(0.05, COATING_PROTOTYPES.thinWhite.lab, 3, 12);
    expect(r.cls).toBe('thinWhite');
  });

  it('高覆盖高粗糙度判厚白', () => {
    const r = classifyCoating(0.2, COATING_PROTOTYPES.thickWhite.lab, 8, 12);
    expect(r.cls).toBe('thickWhite');
  });
});
