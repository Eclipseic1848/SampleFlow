import { strFromU8 } from "fflate";

export function assertFixedValueXlsxArchive(archive:Readonly<Record<string,Uint8Array>>):void {
  for(const [name,content] of Object.entries(archive)){
    const normalized=name.toLowerCase();
    if(normalized.includes("vbaproject.bin"))throw new Error("组织预检拒绝包含宏的工作簿");
    if(normalized.startsWith("xl/externallinks/")
      || normalized==="xl/connections.xml"
      || normalized.startsWith("xl/querytables/")
      || normalized.startsWith("xl/model/"))throw new Error("组织预检拒绝包含外部数据连接的工作簿");
    const xml=normalized.endsWith(".xml")||normalized.endsWith(".rels")?strFromU8(content):"";
    if(normalized.startsWith("xl/worksheets/")&&/<f(?:\s[^>]*)?>/i.test(xml))throw new Error("组织预检拒绝包含公式的工作簿");
    if(normalized.endsWith(".rels")&&/TargetMode\s*=\s*["']External["']/i.test(xml))throw new Error("组织预检拒绝包含外部链接的工作簿");
  }
}
