# 中国省级地图数据来源

- 仓库文件：`china-provinces-mit-1.0.0.geojson`
- 上游包：`chinese-global-compliant-geodata@1.0.0`
- 上游文件：`dist/src/geojson/countries/as/chn/global/chn-level-1.json`
- 上游仓库：https://github.com/JayMuShui/chinese-global-compliant-geodata
- 上游说明：数据来自国家地理信息公共服务平台（天地图），更新时间为 2024 年 5 月；上游于 2025-06-12 整理省级名称、顺序和台湾数据。
- 获取日期：2026-08-31
- npm tarball SHA-1：`92ef93262aeec130fe7cd31654047b07f00253b2`
- npm tarball integrity：`sha512-eBtt4/7uMrCL0gxB069jrZrA88XmSrti++rXIb1SY33yGp45nBdKs7VYeb69DXQP605Uk2tkt1togbW5efu34g==`
- 仓库文件 SHA-256：`11c45e97b70165dfb2bc0c5c8e428108a4723d055e8ffa1663b5eb05783e15d3`
- 处理说明：仓库文件与上游文件字节一致。前端只渲染 34 个省级多边形；不渲染上游的境界线要素，并裁去南海远海范围。
- 审图说明：上游文件没有携带审图号，本项目不把来源地图的审图结论延伸为对当前专题图的审核结论。

## MIT License

Copyright (c) 2025 JayMuShui

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
