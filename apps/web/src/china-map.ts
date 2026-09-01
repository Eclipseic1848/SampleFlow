import { geoMercator, geoPath } from "d3-geo";
import type { Feature, MultiPolygon, Polygon } from "geojson";

type ChinaMapProperties = { name: string; full_name: string; gb: string };

export type ChinaMap = {
  viewBox: string;
  locations: Array<{ id: string; name: string; path: string }>;
};

const expectedProvinceCodes = [
  "110000", "120000", "130000", "140000", "150000", "210000", "220000", "230000",
  "310000", "320000", "330000", "340000", "350000", "360000", "370000", "410000",
  "420000", "430000", "440000", "450000", "460000", "500000", "510000", "520000",
  "530000", "540000", "610000", "620000", "630000", "640000", "650000", "710000",
  "810000", "820000",
] as const;
const expectedProvinceCodeSet = new Set<string>(expectedProvinceCodes);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readProvinceFeatures(payload: unknown): Array<Feature<MultiPolygon, ChinaMapProperties>> {
  if (!isRecord(payload) || payload.type !== "FeatureCollection" || !Array.isArray(payload.features)) throw new Error("中国省级地图格式无效");
  const provinces: Array<Feature<MultiPolygon, ChinaMapProperties>> = [];
  const actualCodes = new Set<string>();
  for (const candidate of payload.features) {
    if (!isRecord(candidate) || candidate.type !== "Feature" || !isRecord(candidate.properties) || !isRecord(candidate.geometry)) throw new Error("中国省级地图要素无效");
    if (candidate.properties.gb === "") continue;
    const { full_name: fullName, gb, name } = candidate.properties;
    if (typeof gb !== "string" || typeof name !== "string" || typeof fullName !== "string" || candidate.geometry.type !== "MultiPolygon" || !Array.isArray(candidate.geometry.coordinates)) throw new Error("中国省级地图要素无效");
    const code = gb.slice(3);
    if (gb.length !== 9 || !gb.startsWith("156") || !expectedProvinceCodeSet.has(code) || actualCodes.has(code)) throw new Error("中国省级地图行政区代码无效");
    actualCodes.add(code);
    provinces.push(candidate as unknown as Feature<MultiPolygon, ChinaMapProperties>);
  }
  if (actualCodes.size !== expectedProvinceCodes.length || expectedProvinceCodes.some((code) => !actualCodes.has(code))) throw new Error("中国省级地图行政区不完整");
  return provinces;
}

export async function loadChinaMap(signal: AbortSignal): Promise<ChinaMap> {
  const response = await fetch(`${import.meta.env.BASE_URL}maps/china-provinces-mit-1.0.0.geojson`, { signal });
  if (!response.ok) throw new Error("中国省级地图加载失败");
  const provinces = readProvinceFeatures(await response.json());
  const displayBounds: Feature<Polygon> = {
    type: "Feature",
    properties: null,
    geometry: { type: "Polygon", coordinates: [[[73, 17], [73, 54], [136, 54], [136, 17], [73, 17]]] },
  };
  const projection = geoMercator().fitExtent([[12, 12], [988, 608]], displayBounds).clipExtent([[0, 0], [1000, 608]]);
  const renderPath = geoPath(projection);
  const locations = provinces.map((province, index) => {
    const path = renderPath(province);
    if (!path) throw new Error(`中国省级地图第 ${index + 1} 个要素无法渲染`);
    return { id: province.properties.gb.slice(3), name: province.properties.full_name, path };
  });
  return { viewBox: "0 0 1000 620", locations };
}
