export const STANDARD_BUSINESS_REGIONS = [
  ["CN-BJ", "北京市"], ["CN-TJ", "天津市"], ["CN-HE", "河北省"], ["CN-SX", "山西省"],
  ["CN-NM", "内蒙古自治区"], ["CN-LN", "辽宁省"], ["CN-JL", "吉林省"], ["CN-HL", "黑龙江省"],
  ["CN-SH", "上海市"], ["CN-JS", "江苏省"], ["CN-ZJ", "浙江省"], ["CN-AH", "安徽省"],
  ["CN-FJ", "福建省"], ["CN-JX", "江西省"], ["CN-SD", "山东省"], ["CN-HA", "河南省"],
  ["CN-HB", "湖北省"], ["CN-HN", "湖南省"], ["CN-GD", "广东省"], ["CN-GX", "广西壮族自治区"],
  ["CN-HI", "海南省"], ["CN-CQ", "重庆市"], ["CN-SC", "四川省"], ["CN-GZ", "贵州省"],
  ["CN-YN", "云南省"], ["CN-XZ", "西藏自治区"], ["CN-SN", "陕西省"], ["CN-GS", "甘肃省"],
  ["CN-QH", "青海省"], ["CN-NX", "宁夏回族自治区"], ["CN-XJ", "新疆维吾尔自治区"],
  ["CN-TW", "台湾省"],
  ["EXT-TRADE", "外贸"],
] as const;

const businessRegionNames = new Map<string, string>(STANDARD_BUSINESS_REGIONS);

export function standardBusinessRegionName(code: string): string | undefined {
  return businessRegionNames.get(code);
}
