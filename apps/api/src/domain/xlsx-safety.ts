import { strFromU8, unzipSync } from "fflate";

const MIB = 1024 * 1024;
const MAX_COMPRESSED_BYTES = 20 * MIB;
const MAX_ARCHIVE_ENTRIES = 256;
const MAX_ENTRY_BYTES = 32 * MIB;
const MAX_UNCOMPRESSED_BYTES = 64 * MIB;

export function unzipFixedValueXlsxArchive(sourceBytes: Uint8Array): Readonly<Record<string, Uint8Array>> {
  if (sourceBytes.byteLength > MAX_COMPRESSED_BYTES) throw new Error("导入预检拒绝压缩文件超过 20 MiB 的工作簿");
  let entries = 0;
  let uncompressedBytes = 0;
  const archive = unzipSync(sourceBytes, { filter: (file) => {
    entries += 1;
    if (entries > MAX_ARCHIVE_ENTRIES) throw new Error("导入预检拒绝文件数超过 256 的工作簿");
    if (file.originalSize > MAX_ENTRY_BYTES) throw new Error("导入预检拒绝单个文件解压后超过 32 MiB 的工作簿");
    uncompressedBytes += file.originalSize;
    if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) throw new Error("导入预检拒绝解压后总大小超过 64 MiB 的工作簿");
    return true;
  } });
  assertFixedValueXlsxArchive(archive);
  return archive;
}

export function assertFixedValueXlsxArchive(archive:Readonly<Record<string,Uint8Array>>):void {
  for(const [name,content] of Object.entries(archive)){
    const normalized=name.toLowerCase();
    if(normalized.includes("vbaproject.bin"))throw new Error("导入预检拒绝包含宏的工作簿");
    if(normalized.startsWith("xl/externallinks/")
      || normalized==="xl/connections.xml"
      || normalized.startsWith("xl/querytables/")
      || normalized.startsWith("xl/model/"))throw new Error("导入预检拒绝包含外部数据连接的工作簿");
    const xml=normalized.endsWith(".xml")||normalized.endsWith(".rels")?strFromU8(content):"";
    if(normalized.startsWith("xl/worksheets/")&&/<f(?:\s[^>]*)?>/i.test(xml))throw new Error("导入预检拒绝包含公式的工作簿");
    if(normalized.endsWith(".rels")&&/TargetMode\s*=\s*["']External["']/i.test(xml))throw new Error("导入预检拒绝包含外部链接的工作簿");
  }
}
