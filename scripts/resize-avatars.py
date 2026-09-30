#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 avatars/ 下的头像统一缩到指定尺寸（幂等：已经是该尺寸的再跑一次无变化）。

用法：python scripts/resize-avatars.py <avatars目录> <尺寸>
"""
import sys
import os
from PIL import Image

def main():
    if len(sys.argv) < 3:
        print('用法: python resize-avatars.py <avatars目录> <尺寸>')
        sys.exit(1)
    out_dir = sys.argv[1]
    size = int(sys.argv[2])

    files = sorted(f for f in os.listdir(out_dir) if f.lower().endswith('.png'))
    if not files:
        print('目录里没有 PNG')
        return

    changed = 0
    for i, f in enumerate(files, 1):
        p = os.path.join(out_dir, f)
        im = Image.open(p)
        if im.size == (size, size):
            continue
        im = im.convert('RGBA')
        im.resize((size, size), Image.LANCZOS).save(p, 'PNG', optimize=True)
        changed += 1
        if i % 50 == 0:
            print(f'  已处理 {i}/{len(files)}', flush=True)

    total = sum(os.path.getsize(os.path.join(out_dir, f)) for f in files)
    print(f'  缩图 {changed} 张（共 {len(files)} 张），合计 {total / 1048576:.2f} MB')

main()
