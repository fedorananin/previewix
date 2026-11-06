/**
 * Reading of dBase tables (.dbf: dBase III, IV and 7, FoxPro, Visual FoxPro) into a flat table of
 * display-ready text, with the memo file next to the table when it is passed along. Read-only.
 * No vscode import, so it can be exercised outside VS Code.
 *
 * Bundled as a file of its own, this module is also a worker thread entry: started with
 * `workerData.previewixDbf`, it reads the bytes passed along and posts the result.
 */
import { isMainThread, parentPort, workerData } from 'worker_threads';
import { FlatBuilder, type FlatTable } from './csv';
import { textDecoder } from './textDecoding';

/**
 * Records are padded to their full width, so the size of the file says little about the size of
 * the table. The table is cut instead: the first records up to whichever limit is reached first.
 */
export const MAX_ROWS = 1_000_000;
export const MAX_CELLS = 10_000_000;
export const MAX_CHARS = 128 * 1024 * 1024;

/** Bytes shown of one memo. A length field of a damaged memo file may claim the whole file for every record. */
const MAX_MEMO = 1024 * 1024;
/** Records are decoded this many bytes at a time, so the decoded text of a large file is never in memory at once. */
const CHUNK = 8 * 1024 * 1024;
/** High bytes looked at to guess the code page. */
const GUESS_SAMPLE = 65536;

export interface DbfOptions {
  /** Content of the memo file next to the table (.dbt or .fpt), when there is one. */
  memo?: Uint8Array;
  /** Content of the .cpg file next to the table, when there is one. */
  cpg?: string;
  /** Code page picked by the user: an `id` from DBF_ENCODINGS. Empty or absent: detect. */
  encoding?: string;
}

export interface DbfInfo {
  /** What wrote the file, from the version byte: 'dBase III', 'dBase IV', 'FoxPro', 'Visual FoxPro', 'dBase 7', … */
  format: string;
  /** Records in the file that are not deleted (may be more than the rows of the table when the limits cut it). */
  records: number;
  /** Records marked as deleted, which are left out. */
  deleted: number;
  /** Id (from DBF_ENCODINGS) and label of the code page the text was read with. */
  encoding: string;
  encodingLabel: string;
  /** Where it came from: the user's choice, the .cpg file, the language driver byte of the header, or a guess from the bytes. */
  encodingSource: 'chosen' | 'cpg' | 'header' | 'guess';
  /** Date of the last update from the header as ISO, when it is a real date. */
  updated?: string;
  /** 'none' (no memo fields), 'read', or 'missing' (memo fields, but no usable memo file was given). */
  memo: 'none' | 'read' | 'missing';
  /** Anything the user should know: truncated file, records cut by the limits, a memo file that doesn't fit. */
  warning?: string;
}

export interface DbfTable extends FlatTable {
  /** Field names, decoded. Duplicates and empty names are kept as they are. */
  names: string[];
  /** The type of every field: short for the column header ('C(20)', 'N(10,2)', 'D'), and written out for the tooltip. */
  types: string[];
  details: string[];
  /** 1 for the columns whose cells are numbers. */
  numeric: Uint8Array;
  info: DbfInfo;
}

/** A reason given in words of our own. Anything else that is thrown is a bug or a file damaged in a new way, and is wrapped. */
class Refusal extends Error {}

const NOT_DBASE = 'This is not a dBase table, or its header is damaged.';
const HEADER_CUT = 'The file ends inside its header, before all the fields are described.';

// ---------------------------------------------------------------------------------------------
// Code pages

interface CodePage {
  id: string;
  label: string;
  /** Windows code page numbers that mean this page, which is how .cpg files and language drivers name it. */
  numbers: number[];
  /** Label for TextDecoder, when it isn't the id. */
  decoder?: string;
  /** The upper 128 characters, for the pages TextDecoder doesn't have. */
  table?: string;
  /** A character may take several bytes, so a field can't be sliced out of text decoded in one piece. */
  multibyte?: boolean;
}

/**
 * Upper halves of the DOS and Mac pages that are missing from the WHATWG encodings, which are all
 * TextDecoder knows. Generated from Python's codecs of the same names; \ufffd is a byte the page leaves undefined.
 */
const TABLES = {
  cp437: 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\xa0',
  cp850: 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\xad±‗¾¶§÷¸°¨·¹³²■\xa0',
  cp852: 'ÇüéâäůćçłëŐőîŹÄĆÉĹĺôöĽľŚśÖÜŤťŁ×čáíóúĄąŽžĘę¬źČş«»░▒▓│┤ÁÂĚŞ╣║╗╝Żż┐└┴┬├─┼Ăă╚╔╩╦╠═╬¤đĐĎËďŇÍÎě┘┌█▄ŢŮ▀ÓßÔŃńňŠšŔÚŕŰýÝţ´\xad˝˛ˇ˘§÷¸°¨˙űŘř■\xa0',
  cp855: 'ђЂѓЃёЁєЄѕЅіІїЇјЈљЉњЊћЋќЌўЎџЏюЮъЪаАбБцЦдДеЕфФгГ«»░▒▓│┤хХиИ╣║╗╝йЙ┐└┴┬├─┼кК╚╔╩╦╠═╬¤лЛмМнНоОп┘┌█▄Пя▀ЯрРсСтТуУжЖвВьЬ№\xadыЫзЗшШэЭщЩчЧ§■\xa0',
  cp857: 'ÇüéâäàåçêëèïîıÄÅÉæÆôöòûùİÖÜø£ØŞşáíóúñÑĞğ¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ºªÊËÈ\ufffdÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµ\ufffd×ÚÛÙìÿ¯´\xad±\ufffd¾¶§÷¸°¨·¹³²■\xa0',
  cp860: 'ÇüéâãàÁçêÊèÍÔìÃÂÉÀÈôõòÚùÌÕÜ¢£Ù₧ÓáíóúñÑªº¿Ò¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\xa0',
  cp861: 'ÇüéâäàåçêëèÐðÞÄÅÉæÆôöþûÝýÖÜø£Ø₧ƒáíóúÁÍÓÚ¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\xa0',
  cp862: 'אבגדהוזחטיךכלםמןנסעףפץצקרשת¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\xa0',
  cp863: 'ÇüéâÂà¶çêëèïî‗À§ÉÈÊôËÏûù¤ÔÜ¢£ÙÛƒ¦´óú¨¸³¯Î⌐¬½¼¾«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\xa0',
  cp865: 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø₧ƒáíóúñÑªº¿⌐¬½¼¡«¤░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\xa0',
  cp737: 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρσςτυφχψ░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀ωάέήϊίόύϋώΆΈΉΊΌΎΏ±≥≤ΪΫ÷≈°∙·√ⁿ²■\xa0',
  cp775: 'ĆüéāäģåćłēŖŗīŹÄÅÉæÆōöĢ¢ŚśÖÜø£Ø×¤ĀĪóŻżź”¦©®¬½¼Ł«»░▒▓│┤ĄČĘĖ╣║╗╝ĮŠ┐└┴┬├─┼ŲŪ╚╔╩╦╠═╬Žąčęėįšųūž┘┌█▄▌▐▀ÓßŌŃõÕµńĶķĻļņĒŅ’\xad±“¾¶§÷„°∙·¹³²■\xa0',
  mac_latin2: 'ÄĀāÉĄÖÜáąČäčĆćéŹźĎíďĒēĖóėôöõúĚěü†°Ę£§•¶ß®©™ę¨≠ģĮįĪ≤≥īĶ∂∑łĻļĽľĹĺŅņŃ¬√ńŇ∆«»…\xa0ňŐÕőŌ–—“”‘’÷◊ōŔŕŘ‹›řŖŗŠ‚„šŚśÁŤťÍŽžŪÓÔūŮÚůŰűŲųÝýķŻŁżĢˇ',
  mac_greek: 'Ä¹²É³ÖÜ΅àâä΄¨çéèêë£™îï•½‰ôö¦€ùûü†ΓΔΘΛΞΠß®©ΣΪ§≠°·Α±≤≥¥ΒΕΖΗΙΚΜΦΫΨΩάΝ¬ΟΡ≈Τ«»…\xa0ΥΧΆΈœ–―“”‘’÷ΉΊΌΎέήίόΏύαβψδεφγηιξκλμνοπώρστθωςχυζϊϋΐΰ\xad',
};

/** Every code page the reader knows, in the order of the list offered for the override. */
const ALL_PAGES: CodePage[] = [
  { id: 'utf-8', label: 'Unicode (UTF-8)', numbers: [65001], multibyte: true },
  // Also stands in for ISO 8859-1, as it does for TextDecoder: the two differ only in control characters.
  { id: 'windows-1252', label: 'Western European (Windows-1252)', numbers: [1252, 28591, 819] },
  { id: 'cp437', label: 'DOS US (CP437)', numbers: [437], table: TABLES.cp437 },
  { id: 'cp850', label: 'DOS Western European (CP850)', numbers: [850], table: TABLES.cp850 },
  { id: 'windows-1250', label: 'Central European (Windows-1250)', numbers: [1250] },
  { id: 'cp852', label: 'DOS Central European (CP852)', numbers: [852], table: TABLES.cp852 },
  { id: 'windows-1251', label: 'Cyrillic (Windows-1251)', numbers: [1251] },
  { id: 'cp866', label: 'DOS Cyrillic (CP866)', numbers: [866], decoder: 'ibm866' },
  { id: 'cp855', label: 'DOS Cyrillic (CP855)', numbers: [855], table: TABLES.cp855 },
  { id: 'koi8-r', label: 'Cyrillic (KOI8-R)', numbers: [20866] },
  { id: 'koi8-u', label: 'Cyrillic (KOI8-U)', numbers: [21866] },
  { id: 'windows-1253', label: 'Greek (Windows-1253)', numbers: [1253] },
  { id: 'cp737', label: 'DOS Greek (CP737)', numbers: [737], table: TABLES.cp737 },
  { id: 'windows-1254', label: 'Turkish (Windows-1254)', numbers: [1254, 28599] },
  { id: 'cp857', label: 'DOS Turkish (CP857)', numbers: [857], table: TABLES.cp857 },
  { id: 'windows-1257', label: 'Baltic (Windows-1257)', numbers: [1257] },
  { id: 'cp775', label: 'DOS Baltic (CP775)', numbers: [775], table: TABLES.cp775 },
  { id: 'windows-1255', label: 'Hebrew (Windows-1255)', numbers: [1255] },
  { id: 'cp862', label: 'DOS Hebrew (CP862)', numbers: [862], table: TABLES.cp862 },
  { id: 'windows-1256', label: 'Arabic (Windows-1256)', numbers: [1256] },
  { id: 'windows-1258', label: 'Vietnamese (Windows-1258)', numbers: [1258] },
  { id: 'windows-874', label: 'Thai (Windows-874)', numbers: [874, 28601] },
  { id: 'cp860', label: 'DOS Portuguese (CP860)', numbers: [860], table: TABLES.cp860 },
  { id: 'cp861', label: 'DOS Icelandic (CP861)', numbers: [861], table: TABLES.cp861 },
  { id: 'cp863', label: 'DOS Canadian French (CP863)', numbers: [863], table: TABLES.cp863 },
  { id: 'cp865', label: 'DOS Nordic (CP865)', numbers: [865], table: TABLES.cp865 },
  { id: 'macintosh', label: 'Mac Roman', numbers: [10000] },
  { id: 'mac-latin2', label: 'Mac Central European', numbers: [10029], table: TABLES.mac_latin2 },
  { id: 'x-mac-cyrillic', label: 'Mac Cyrillic', numbers: [10007] },
  { id: 'mac-greek', label: 'Mac Greek', numbers: [10006], table: TABLES.mac_greek },
  { id: 'iso-8859-2', label: 'Central European (ISO 8859-2)', numbers: [28592] },
  { id: 'iso-8859-3', label: 'South European (ISO 8859-3)', numbers: [28593] },
  { id: 'iso-8859-4', label: 'North European (ISO 8859-4)', numbers: [28594] },
  { id: 'iso-8859-5', label: 'Cyrillic (ISO 8859-5)', numbers: [28595] },
  { id: 'iso-8859-6', label: 'Arabic (ISO 8859-6)', numbers: [28596] },
  { id: 'iso-8859-7', label: 'Greek (ISO 8859-7)', numbers: [28597] },
  { id: 'iso-8859-8', label: 'Hebrew (ISO 8859-8)', numbers: [28598] },
  { id: 'iso-8859-10', label: 'Nordic (ISO 8859-10)', numbers: [28600] },
  { id: 'iso-8859-13', label: 'Baltic (ISO 8859-13)', numbers: [28603] },
  { id: 'iso-8859-14', label: 'Celtic (ISO 8859-14)', numbers: [28604] },
  { id: 'iso-8859-15', label: 'Western European (ISO 8859-15)', numbers: [28605] },
  { id: 'iso-8859-16', label: 'South-Eastern European (ISO 8859-16)', numbers: [28606] },
  { id: 'shift_jis', label: 'Japanese (Shift JIS, CP932)', numbers: [932], multibyte: true },
  { id: 'euc-jp', label: 'Japanese (EUC-JP)', numbers: [20932, 51932], multibyte: true },
  { id: 'gbk', label: 'Chinese Simplified (GBK, CP936)', numbers: [936, 54936], multibyte: true },
  { id: 'big5', label: 'Chinese Traditional (Big5, CP950)', numbers: [950], multibyte: true },
  { id: 'euc-kr', label: 'Korean (EUC-KR, CP949)', numbers: [949, 51949], multibyte: true },
];

/**
 * The pages this runtime can read. One without a table depends on TextDecoder, and not every runtime has every
 * WHATWG encoding: Node.js 22 knows no ISO 8859-16. Such a page is left out of the list and is found by no name
 * or number either, so a file that asks for it is read like one that names a page nobody knows, by the guess
 * and with a note, instead of failing when its text is decoded.
 */
const PAGES = ALL_PAGES.filter((page) => {
  if (page.table) {
    return true;
  }
  try {
    textDecoder(page.decoder ?? page.id);
    return true;
  } catch {
    return false;
  }
});

/** The code pages offered for the override, in the order of the list. */
export const DBF_ENCODINGS: { id: string; label: string }[] = PAGES.map(({ id, label }) => ({ id, label }));

const PAGE_BY_ID = new Map(PAGES.map((page) => [page.id, page]));
const PAGE_BY_NUMBER = new Map(PAGES.flatMap((page) => page.numbers.map((number) => [number, page] as const)));

/** A name as it is compared: upper case, letters and digits only, so 'Windows-1251', 'windows_1251' and 'WINDOWS 1251' are one. */
function bare(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The page of each pair that this runtime has. */
function having<K>(pairs: (readonly [K, CodePage | undefined])[]): Map<K, CodePage> {
  return new Map(pairs.filter((pair): pair is readonly [K, CodePage] => !!pair[1]));
}

const PAGE_BY_NAME = having<string>([
  ...PAGES.map((page) => [bare(page.id), page] as const),
  ...Object.entries({
    UTF8: 'utf-8',
    LATIN1: 'windows-1252',
    L1: 'windows-1252',
    LATIN2: 'iso-8859-2',
    LATIN9: 'iso-8859-15',
    SJIS: 'shift_jis',
    MSKANJI: 'shift_jis',
    GB2312: 'gbk',
    GB18030: 'gbk',
    EUCCN: 'gbk',
    BIG5HKSCS: 'big5',
    UHC: 'euc-kr',
    KSC5601: 'euc-kr',
    TIS620: 'windows-874',
    MAC: 'macintosh',
    MACROMAN: 'macintosh',
    MACCYRILLIC: 'x-mac-cyrillic',
    MACCENTRALEUROPE: 'mac-latin2',
  }).map(([name, id]) => [name, PAGE_BY_ID.get(id)] as const),
]);

/**
 * The language driver IDs of the header (byte 29) by the code page they stand for. 0x68 (Kamenický)
 * and 0x69 (Mazovia) are known IDs without a table here, so such a file falls through to the guess.
 */
const DRIVERS: [number, number[]][] = [
  [437, [0x01, 0x09, 0x0b, 0x0d, 0x0f, 0x11, 0x15, 0x18, 0x19, 0x1b]],
  [850, [0x02, 0x0a, 0x0e, 0x10, 0x12, 0x14, 0x16, 0x1a, 0x1d, 0x25, 0x37]],
  [852, [0x1f, 0x22, 0x23, 0x40, 0x64, 0x87]],
  [865, [0x08, 0x17, 0x66]],
  [866, [0x26, 0x65]],
  [860, [0x24]],
  [861, [0x67]],
  [863, [0x1c, 0x6c]],
  [737, [0x6a, 0x86]],
  [857, [0x6b, 0x88]],
  [932, [0x13, 0x7b]],
  [936, [0x4d, 0x7a]],
  [949, [0x4e, 0x79]],
  [950, [0x4f, 0x78]],
  [874, [0x50, 0x7c]],
  [1250, [0xc8]],
  [1251, [0xc9]],
  [1252, [0x03, 0x57, 0x58, 0x59]],
  [1253, [0xcb]],
  [1254, [0xca]],
  [1255, [0x7d]],
  [1256, [0x7e]],
  [1257, [0xcc]],
  [10000, [0x04]],
  [10007, [0x96]],
  [10029, [0x97]],
  [10006, [0x98]],
];
const PAGE_BY_DRIVER = having(DRIVERS.flatMap(([number, ids]) => ids.map((id) => [id, PAGE_BY_NUMBER.get(number)] as const)));
const DRIVER_WITHOUT_TABLE: Record<number, string> = { 0x68: 'Kamenický', 0x69: 'Mazovia' };

/** ISO 8859 parts by number. Parts 1, 9 and 11 are read as the Windows pages that extend them, as TextDecoder does. */
function isoPage(part: number): CodePage | undefined {
  return PAGE_BY_ID.get(part === 1 ? 'windows-1252' : part === 9 ? 'windows-1254' : part === 11 ? 'windows-874' : `iso-8859-${part}`);
}

/**
 * The code page a .cpg file names. Such files come from many programs: 'UTF-8', '1251', 'CP1251',
 * 'Windows-1251', 'ANSI 1251', 'OEM 866', 'ISO-8859-1', '88591' (Esri), 'LDID/101', 'BIG5', 'SJIS'.
 */
function cpgPage(name: string): CodePage | undefined {
  const driver = /^\s*LDID\s*\/\s*(\d+)\s*$/i.exec(name);
  if (driver) {
    return PAGE_BY_DRIVER.get(Number(driver[1]));
  }
  const key = bare(name);
  const iso = /^(?:ISO)?8859(\d{1,2})$/.exec(key);
  if (iso) {
    return isoPage(Number(iso[1]));
  }
  const number = /^(?:CP|WINDOWS|WIN|ANSI|OEM|IBM|MS|DOS|PC)?(\d+)$/.exec(key);
  return number ? PAGE_BY_NUMBER.get(Number(number[1])) : PAGE_BY_NAME.get(key);
}

interface Decoding {
  /** One character for every byte, so that a field is a slice by arithmetic. Of a multi-byte page only the ASCII of it is right. */
  aligned(bytes: Uint8Array): string;
  /** The text of a piece on its own. */
  text(bytes: Uint8Array): string;
}

function decoding(page: CodePage): Decoding {
  if (page.table) {
    // Mapped to UTF-16 code units and turned into a string in one call, which is far faster than
    // building it character by character. Typed arrays have the byte order of the machine, which
    // is little-endian wherever VS Code runs.
    const units = new Uint16Array(256);
    for (let i = 0; i < 128; i++) {
      units[i] = i;
      units[128 + i] = page.table.charCodeAt(i);
    }
    const utf16 = new TextDecoder('utf-16le', { ignoreBOM: true });
    const text = (bytes: Uint8Array): string => {
      const mapped = new Uint16Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) {
        mapped[i] = units[bytes[i]];
      }
      return utf16.decode(mapped);
    };
    return { aligned: text, text };
  }
  const decoder = textDecoder(page.decoder ?? page.id, { ignoreBOM: true });
  const text = (bytes: Uint8Array): string => decoder.decode(bytes);
  if (!page.multibyte) {
    // Every single-byte decoder gives exactly one UTF-16 unit per byte, also for the bytes a page leaves undefined.
    return { aligned: text, text };
  }
  const ascii = textDecoder('windows-1252');
  return { aligned: (bytes) => ascii.decode(bytes), text };
}

// ---------------------------------------------------------------------------------------------
// Header

interface Field {
  name: Uint8Array;
  type: string;
  length: number;
  decimals: number;
  flags: number;
  /** Offset of the field in the record, after the deletion flag. */
  offset: number;
}

interface Header {
  version: number;
  /** dBase 7: a longer header, longer field descriptors, and binary values stored most significant byte first. */
  level7: boolean;
  /** Records according to the header, which is only a hint. */
  count: number;
  headerLength: number;
  recordLength: number;
  /** The language driver: its ID, and in dBase 7 its name as well, such as 'DB437US0'. */
  driver: number;
  driverName: string;
  updated?: string;
  fields: Field[];
}

const FORMATS: Record<number, string> = {
  0x03: 'dBase III',
  0x04: 'dBase 7',
  0x05: 'dBase 5',
  0x07: 'Visual Objects',
  0x30: 'Visual FoxPro',
  0x31: 'Visual FoxPro',
  0x32: 'Visual FoxPro',
  0x43: 'dBase IV',
  0x63: 'dBase IV',
  0x7b: 'dBase IV',
  0x83: 'dBase III',
  0x87: 'Visual Objects',
  0x8b: 'dBase IV',
  0x8c: 'dBase 7',
  0x8e: 'dBase IV',
  0xcb: 'dBase IV',
  0xe5: 'Clipper SIx',
  0xf5: 'FoxPro',
  0xfb: 'FoxBase',
};

/** Field flags of Visual FoxPro. */
const NULLABLE = 0x02;

/** The type of the system field `_NullFlags`, which is not a column. */
const NULL_FLAGS = '0';

/**
 * Reads the field descriptors, which run up to a 0x0D byte. `size` is 32 with the name in 11 bytes,
 * or 48 with the name in 32 bytes (dBase 7). Gives a reason instead of the fields when they make no sense.
 */
function readFields(bytes: Uint8Array, start: number, size: number, headerLength: number, recordLength: number): Field[] | string {
  const wide = size === 48;
  const fields: Field[] = [];
  let offset = 1;
  for (let pos = start; pos < headerLength; pos += size) {
    if (pos >= bytes.length) {
      return HEADER_CUT;
    }
    // Some writers leave the terminator out and let the descriptors fill the header.
    if (bytes[pos] === 0x0d || pos + size > headerLength) {
      break;
    }
    if (pos + size > bytes.length) {
      return HEADER_CUT;
    }
    const nameLength = wide ? 32 : 11;
    let nameEnd = pos;
    while (nameEnd < pos + nameLength && bytes[nameEnd] !== 0) {
      // A control character in a name means that this is something else than a list of fields.
      if (bytes[nameEnd] < 0x20) {
        return NOT_DBASE;
      }
      nameEnd++;
    }
    const typeByte = bytes[pos + nameLength];
    if (typeByte < 0x21 || typeByte > 0x7e) {
      return NOT_DBASE;
    }
    const type = String.fromCharCode(typeByte).toUpperCase();
    const decimals = bytes[pos + (wide ? 34 : 17)];
    // A character field longer than 255 bytes (Clipper, FoxPro) keeps the high byte of its length where the decimals are.
    const length = bytes[pos + (wide ? 33 : 16)] + (type === 'C' ? decimals << 8 : 0);
    fields.push({ name: bytes.subarray(pos, nameEnd), type, length, decimals: type === 'C' ? 0 : decimals, flags: wide ? 0 : bytes[pos + 18], offset });
    offset += length;
  }
  return offset > recordLength ? NOT_DBASE : fields;
}

function readHeader(bytes: Uint8Array): Header {
  if (bytes.length === 0) {
    throw new Refusal('The file is empty.');
  }
  const version = bytes[0];
  if (version === 0x02) {
    throw new Refusal('This is a dBase II table, which Previewix does not read.');
  }
  if (bytes.length < 32) {
    throw new Refusal(HEADER_CUT);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);
  if (headerLength < 33 || recordLength < 1) {
    throw new Refusal(NOT_DBASE);
  }

  // The version byte tells dBase 7 apart by its low three bits, but other programs have used the
  // same values, so the layout that fits the record length decides.
  let level7 = (version & 0x07) === 4;
  let fields = level7 ? readFields(bytes, 68, 48, headerLength, recordLength) : NOT_DBASE;
  if (typeof fields === 'string') {
    level7 = false;
    const classic = readFields(bytes, 32, 32, headerLength, recordLength);
    if (typeof classic === 'string') {
      throw new Refusal(fields === HEADER_CUT ? fields : classic);
    }
    fields = classic;
  }

  return {
    version,
    level7,
    count: view.getUint32(4, true),
    headerLength,
    recordLength,
    driver: bytes[29],
    driverName: level7 ? String.fromCharCode(...bytes.subarray(32, 64)).replace(/[^\x21-\x7e].*$/s, '') : '',
    updated: updateDate(bytes[1], bytes[2], bytes[3]),
    fields,
  };
}

/** The year is kept as years since 1900, but many writers store only its last two digits. */
function updateDate(yy: number, month: number, day: number): string | undefined {
  const year = yy < 80 ? 2000 + yy : 1900 + yy;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return `${year}-${two(month)}-${two(day)}`;
}

// ---------------------------------------------------------------------------------------------
// Columns

/** How the bytes of a field become the text of a cell. */
const TEXT = 0;
const NUMBER = 1;
const DATE = 2;
const LOGICAL = 3;
const INTEGER = 4;
const CURRENCY = 5;
const DATETIME = 6;
const DOUBLE = 7;
const STAMP = 8;
const MEMO = 9;
const BINARY = 10;
const VARCHAR = 11;
const VARBINARY = 12;

interface Column {
  name: Uint8Array;
  kind: number;
  type: string;
  detail: string;
  numeric: boolean;
  offset: number;
  length: number;
  /** Bits of this field in the `_NullFlags` field of Visual FoxPro, or -1: "is null", and "shorter than the field" of a varchar. */
  nullBit: number;
  lengthBit: number;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function describe(field: Field, level7: boolean): Pick<Column, 'kind' | 'type' | 'detail' | 'numeric'> {
  const { type, length, decimals } = field;
  const column = (kind: number, detail: string, short = type, numeric = false) => ({ kind, type: short, detail, numeric });
  const sized = `${type}(${length}${decimals ? `,${decimals}` : ''})`;
  const digits = `${plural(length, 'digit')}${decimals ? `, ${plural(decimals, 'decimal')}` : ''}`;
  switch (type) {
    case 'C':
      return column(TEXT, `Character, ${plural(length, 'byte')}`, sized);
    case 'N':
      return column(NUMBER, `Number, ${digits}`, sized, true);
    case 'F':
      return column(NUMBER, `Float, ${digits}`, sized, true);
    case 'L':
      return column(LOGICAL, 'Logical');
    case 'M':
      return column(MEMO, 'Memo');
    case 'G':
      return column(BINARY, 'General (OLE object)');
    case 'P':
      return column(BINARY, 'Picture');
    case 'W':
      return column(BINARY, 'Blob');
    case 'V':
      return column(VARCHAR, `Varchar, up to ${plural(length, 'byte')}`, sized);
    case 'Q':
      return column(VARBINARY, `Varbinary, up to ${plural(length, 'byte')}`, sized);
  }
  // The binary types have one size each. A field of another size is something this reader doesn't
  // know, and is shown as the text it holds, like any unknown type.
  if (type === 'D' && length === 8) {
    return column(DATE, 'Date');
  }
  if ((type === 'I' || type === '+') && length === 4) {
    return column(INTEGER, type === 'I' ? 'Integer, 32 bits' : 'Autoincrement, 32 bits', type, true);
  }
  if (type === 'Y' && length === 8) {
    return column(CURRENCY, 'Currency, 4 decimals', type, true);
  }
  if (type === 'T' && length === 8) {
    return column(DATETIME, 'Date and time');
  }
  if (type === '@' && length === 8) {
    return column(level7 ? STAMP : DATETIME, 'Timestamp');
  }
  if (type === 'O' && length === 8) {
    return column(DOUBLE, 'Double', type, true);
  }
  if (type === 'B') {
    // Visual FoxPro took the letter of dBase's binary memo for its double. The size tells them apart.
    return length === 8 ? column(DOUBLE, 'Double', type, true) : column(BINARY, 'Binary memo');
  }
  return column(TEXT, `Type ${type}, ${plural(length, 'byte')}, shown as text`, sized);
}

/**
 * The columns of the table, and the field with the null flags when there is one. Visual FoxPro gives
 * every varchar and varbinary field a bit there, and every nullable field another, in the order of the fields.
 */
function readColumns(header: Header): { columns: Column[]; flags?: Field } {
  const columns: Column[] = [];
  let flags: Field | undefined;
  let bit = 0;
  for (const field of header.fields) {
    if (field.type === NULL_FLAGS) {
      flags ??= field;
      continue;
    }
    const described = describe(field, header.level7);
    const lengthBit = described.kind === VARCHAR || described.kind === VARBINARY ? bit++ : -1;
    const nullable = !header.level7 && (field.flags & NULLABLE) !== 0;
    const nullBit = nullable ? bit++ : -1;
    columns.push({
      ...described,
      detail: nullable ? `${described.detail}, nullable` : described.detail,
      name: field.name,
      offset: field.offset,
      length: field.length,
      nullBit,
      lengthBit,
    });
  }
  if (flags && bit > flags.length * 8) {
    // Fewer bits than the fields ask for: the flags are not what they are taken for.
    flags = undefined;
  }
  return { columns, flags };
}

// ---------------------------------------------------------------------------------------------
// Code page of a file

/**
 * Guesses the code page from the text fields: UTF-8 when the bytes are well-formed UTF-8 with at
 * least one character beyond ASCII, a Cyrillic page when the high bytes look like Russian text,
 * Windows-1252 otherwise. Russian words are runs of high bytes, while the accented letters of
 * Western text stand alone between ASCII letters; and CP866 keeps most of its letters at 80-AF,
 * where Windows-1251 has none. Western text with one of the five bytes that Windows-1252 leaves
 * undefined comes from DOS, where these are letters such as ü and É: it is read as CP850, which
 * has the letters of CP437 and more.
 */
function guessPage(bytes: Uint8Array, start: number, recordLength: number, total: number, columns: Column[]): CodePage {
  const texts = columns.filter((column) => column.kind === TEXT || column.kind === VARCHAR);
  let high = 0;
  let inRuns = 0;
  let in866 = 0;
  let in1251 = 0;
  let only866 = 0;
  let only1251 = 0;
  let undefined1252 = 0;
  let utf8 = true;
  let sequences = 0;
  for (let r = 0; r < total && high < GUESS_SAMPLE && texts.length; r++) {
    const record = start + r * recordLength;
    for (const column of texts) {
      const from = record + column.offset;
      const full = from + column.length;
      let end = full;
      while (end > from && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0)) {
        end--;
      }
      // Bytes the UTF-8 sequence at hand still needs, and the range the next of them must be in.
      let need = 0;
      let low = 0x80;
      let top = 0xbf;
      for (let i = from; i < end; i++) {
        const byte = bytes[i];
        if (byte < 0x80) {
          if (need) {
            utf8 = false;
            need = 0;
          }
          continue;
        }
        high++;
        if ((i > from && bytes[i - 1] >= 0x80) || (i + 1 < end && bytes[i + 1] >= 0x80)) {
          inRuns++;
        }
        if (byte === 0x81 || byte === 0x8d || byte === 0x8f || byte === 0x90 || byte === 0x9d) {
          undefined1252++;
        }
        if (byte <= 0xaf) {
          in866++;
          if (byte === 0xa8) {
            in1251++;
          } else {
            only866++;
          }
        } else if (byte >= 0xe0 && byte <= 0xf1) {
          in866++;
          in1251++;
        } else if (byte >= 0xc0) {
          in1251++;
          only1251++;
        } else if (byte === 0xb8) {
          in1251++;
        }

        if (need) {
          if (byte >= low && byte <= top) {
            need--;
            low = 0x80;
            top = 0xbf;
            sequences += need ? 0 : 1;
          } else {
            utf8 = false;
            need = 0;
          }
        } else if (byte >= 0xc2 && byte <= 0xdf) {
          need = 1;
        } else if (byte >= 0xe0 && byte <= 0xef) {
          need = 2;
          low = byte === 0xe0 ? 0xa0 : 0x80;
          top = byte === 0xed ? 0x9f : 0xbf;
        } else if (byte >= 0xf0 && byte <= 0xf4) {
          need = 3;
          low = byte === 0xf0 ? 0x90 : 0x80;
          top = byte === 0xf4 ? 0x8f : 0xbf;
        } else {
          utf8 = false;
        }
      }
      // A character cut in half is what a writer leaves that fills the field by bytes, so it is fine at the very end of a full field only.
      if (need && end < full) {
        utf8 = false;
      }
    }
  }

  if (utf8 && sequences) {
    return PAGE_BY_ID.get('utf-8')!;
  }
  let cyrillic: CodePage | undefined;
  if (inRuns * 2 > high) {
    if (in866 * 10 >= high * 9 && only866 > only1251) {
      cyrillic = PAGE_BY_ID.get('cp866');
    } else if (in1251 * 10 >= high * 9 && only1251 >= only866) {
      cyrillic = PAGE_BY_ID.get('windows-1251');
    }
  }
  return cyrillic ?? PAGE_BY_ID.get(undefined1252 ? 'cp850' : 'windows-1252')!;
}

interface Choice {
  page: CodePage;
  source: DbfInfo['encodingSource'];
  /** What the file named as its code page, when that isn't a page this reader has. */
  unknown: string;
}

/** The user's choice wins over the .cpg file, that over the language driver of the header, and that over the guess. */
function choosePage(options: DbfOptions, { driver, driverName }: Header, guess: () => CodePage): Choice {
  const chosen = options.encoding ? PAGE_BY_ID.get(options.encoding) : undefined;
  if (chosen) {
    return { page: chosen, source: 'chosen', unknown: '' };
  }
  let unknown = '';
  const named = (options.cpg ?? '').replace(/^\ufeff/, '').split(/[\r\n\0]/)[0].trim();
  if (named) {
    const page = cpgPage(named);
    if (page) {
      return { page, source: 'cpg', unknown: '' };
    }
    // "ASCII" and "no driver" name no page at all, which is nothing to tell the user about.
    unknown = /^(?:(?:US)?ASCII|20127|LDID0)$/.test(named.toUpperCase().replace(/[^A-Z0-9]/g, '')) ? '' : `"${named.slice(0, 40)}" in the .cpg file`;
  }
  if (driver) {
    const page = PAGE_BY_DRIVER.get(driver);
    if (page) {
      return { page, source: 'header', unknown: '' };
    }
    const id = `0x${driver.toString(16).toUpperCase().padStart(2, '0')}`;
    unknown ||= `language driver ${id}${DRIVER_WITHOUT_TABLE[driver] ? ` (${DRIVER_WITHOUT_TABLE[driver]})` : ''} in the header`;
  } else if (driverName) {
    // The drivers of dBase 7 carry the number of their code page in the name; the others ('DBWINUS0') don't say.
    const page = PAGE_BY_NUMBER.get(Number(/^DB(\d{3,4})/i.exec(driverName)?.[1]));
    if (page) {
      return { page, source: 'header', unknown: '' };
    }
  }
  return { page: guess(), source: 'guess', unknown };
}

// ---------------------------------------------------------------------------------------------
// Memo file

interface Memo {
  bytes: Uint8Array;
  view: DataView;
  /** FoxPro (.fpt): type and length in front of every memo, most significant byte first. Otherwise a dBase .dbt. */
  fox: boolean;
  blockSize: number;
}

/** Makes sense of the memo file, or gives nothing when it can't belong to this table. */
function openMemo(bytes: Uint8Array | undefined, header: Header, columns: Column[]): Memo | undefined {
  if (!bytes || bytes.length < 24) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = header.version;
  // Only the bytes are passed along, not the name of the file. The table says which kind it is:
  // FoxPro by its version, or by a block number kept as a 4-byte integer, which no .dbt has.
  const fox = (version >= 0x30 && version <= 0x32) || version === 0xf5 || columns.some((column) => column.kind === MEMO && column.length === 4);
  if (fox) {
    const blockSize = view.getUint16(6, false);
    return blockSize ? { bytes, view, fox, blockSize } : undefined;
  }
  // dBase IV and later name the block size; in the file of dBase III these bytes are not defined, and the blocks are 512 bytes.
  const later = header.level7 || version === 0x8b || version === 0x8e || version === 0xcb || version === 0x7b;
  return { bytes, view, fox, blockSize: (later && view.getUint16(20, true)) || 512 };
}

// ---------------------------------------------------------------------------------------------
// Values

function two(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * A Julian day number and the seconds of that day as 'YYYY-MM-DD HH:MM:SS' (Gregorian calendar
 * throughout, as the programs that write these files count). Empty outside the years 1 to 9999,
 * which no real value is.
 */
function dateTime(day: number, seconds: number): string {
  const f = day + 1401 + Math.floor((Math.floor((4 * day + 274277) / 146097) * 3) / 4) - 38;
  const e = 4 * f + 3;
  const h = 5 * Math.floor((e % 1461) / 4) + 2;
  const month = ((Math.floor(h / 153) + 2) % 12) + 1;
  const year = Math.floor(e / 1461) - 4716 + Math.floor((14 - month) / 12);
  if (!(year >= 1 && year <= 9999)) {
    return '';
  }
  const date = `${String(year).padStart(4, '0')}-${two(month)}-${two(Math.floor((h % 153) / 5) + 1)}`;
  return `${date} ${two(Math.floor(seconds / 3600))}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}`;
}

/** Day 1 of the day count of dBase 7 is January 1 of the year 1, which is this many days after Julian day 0. */
const DAY_ONE = 1721425;

/** A number of 64 bits with four implied decimals, written out exactly. */
function currency(value: bigint): string {
  const negative = value < 0n;
  const digits = String(negative ? -value : value).padStart(5, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

function double(value: number): string {
  return value === 0 ? '0' : String(value);
}

/** Where the text ends when the last character of a full field was cut in the middle of its UTF-8 bytes. */
function wholeUtf8(bytes: Uint8Array, from: number, end: number): number {
  let lead = end - 1;
  while (lead > from && end - lead < 4 && (bytes[lead] & 0xc0) === 0x80) {
    lead--;
  }
  const byte = bytes[lead];
  const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
  return length > end - lead ? lead : end;
}

// ---------------------------------------------------------------------------------------------
// The table

export function readDbf(bytes: Uint8Array, options: DbfOptions = {}): DbfTable {
  try {
    return read(bytes, options);
  } catch (e) {
    throw e instanceof Refusal ? e : new Error(`The file is damaged, or written in a way Previewix does not read (${e instanceof Error ? e.message : e}).`);
  }
}

function read(bytes: Uint8Array, options: DbfOptions): DbfTable {
  const header = readHeader(bytes);
  const { columns, flags } = readColumns(header);
  const { headerLength: start, recordLength, level7 } = header;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The count of the header is not to be trusted: some writers leave 0 there, and a file may have
  // lost its end. So the records are what the file holds: whole ones, up to the end marker. Beyond
  // the count of the header only records with a proper deletion flag go on, since what follows the
  // data may be anything.
  const fit = start <= bytes.length ? Math.floor((bytes.length - start) / recordLength) : 0;
  let total = 0;
  while (total < fit) {
    const flag = bytes[start + total * recordLength];
    if (flag === 0x1a || (total >= header.count && flag !== 0x20 && flag !== 0x2a)) {
      break;
    }
    total++;
  }

  const choice = choosePage(options, header, () => guessPage(bytes, start, recordLength, total, columns));
  const page = choice.page;
  const decode = decoding(page);
  const multibyte = page.multibyte === true;
  const utf8 = page.id === 'utf-8';

  const hasMemo = columns.some((column) => column.kind === MEMO);
  // The SIx driver of Clipper keeps memos in a file of a layout of its own (.smt), which is not read.
  const sixMemo = header.version === 0xe5;
  const memo = hasMemo && !sixMemo ? openMemo(options.memo, header, columns) : undefined;
  let memosOutside = 0;
  let memosCut = 0;

  /** The records being read, as text with one character per byte, and the offset of its first byte in the file. */
  let text = '';
  let base = 0;

  /** The block number of a memo: ten digits, or a 4-byte integer in Visual FoxPro. 0 is "no memo". */
  const block = (at: number, length: number): number => {
    if (length === 4) {
      return view.getUint32(at, true);
    }
    let value = 0;
    for (let i = at; i < at + length; i++) {
      const code = bytes[i];
      if (code >= 0x30 && code <= 0x39) {
        value = value * 10 + (code - 0x30);
      } else if (code !== 0x20 && code !== 0) {
        return 0;
      }
    }
    return value;
  };

  const memoText = (number: number, file: Memo): string => {
    const { bytes: data, view: memoView } = file;
    const at = number * file.blockSize;
    let from: number;
    let end: number;
    if (file.fox) {
      if (at + 8 > data.length) {
        memosOutside++;
        return '';
      }
      // 1 is text; 0 is a picture and 2 an object.
      if (memoView.getUint32(at, false) !== 1) {
        return '(binary)';
      }
      from = at + 8;
      end = from + memoView.getUint32(at + 4, false);
    } else {
      if (at >= data.length) {
        memosOutside++;
        return '';
      }
      if (at + 8 <= data.length && memoView.getUint32(at, true) === 0x0008ffff) {
        // dBase IV: the length counts these eight bytes too.
        from = at + 8;
        end = at + Math.max(8, memoView.getUint32(at + 4, true));
      } else {
        // dBase III: the text runs to an end marker, over as many blocks as it takes.
        from = at;
        end = data.indexOf(0x1a, at);
        end = end < 0 ? data.length : end;
      }
    }
    if (end > data.length) {
      memosOutside++;
      end = data.length;
    }
    if (end - from > MAX_MEMO) {
      memosCut++;
      return `${decode.text(data.subarray(from, from + MAX_MEMO))}…`;
    }
    return decode.text(data.subarray(from, end));
  };

  /** A text field from `from` (a position in the file) to `end`, of which the spaces and zero bytes at the end are dropped. */
  const trimmed = (from: number, end: number, full: boolean): string => {
    const first = from - base;
    let last = end - base;
    let code: number;
    while (last > first && ((code = text.charCodeAt(last - 1)) === 32 || code === 0)) {
      last--;
    }
    if (multibyte) {
      for (let i = first; i < last; i++) {
        if (text.charCodeAt(i) >= 0x80) {
          // Only a field that has more than ASCII in it is decoded on its own.
          const stop = base + last;
          return decode.text(bytes.subarray(from, utf8 && full && stop === end ? wholeUtf8(bytes, from, stop) : stop));
        }
      }
    }
    return text.slice(first, last);
  };

  const scratch = new DataView(new ArrayBuffer(8));
  /**
   * A double of dBase 7, which is stored so that the bytes sort like the numbers: most significant
   * byte first, the sign bit turned over, and all bits of a negative number turned over. Eight zero
   * bytes, which no number gives, are the empty value.
   */
  const sortable = (at: number): number | undefined => {
    let high = view.getUint32(at, false);
    let low = view.getUint32(at + 4, false);
    if (!high && !low) {
      return undefined;
    }
    if (high & 0x80000000) {
      high ^= 0x80000000;
    } else {
      high = ~high;
      low = ~low;
    }
    scratch.setUint32(0, high, false);
    scratch.setUint32(4, low, false);
    return scratch.getFloat64(0, false);
  };

  const cell = (column: Column, record: number): string => {
    const at = record + column.offset;
    const length = column.length;
    if (flags && column.nullBit >= 0 && (bytes[record + flags.offset + (column.nullBit >> 3)] >> (column.nullBit & 7)) & 1) {
      return '';
    }
    switch (column.kind) {
      case TEXT:
        return trimmed(at, at + length, true);

      case NUMBER: {
        // The digits as they are stored: a number of 20 digits doesn't survive a float.
        let first = at - base;
        let last = first + length;
        while (last > first && text.charCodeAt(last - 1) <= 32) {
          last--;
        }
        while (first < last && text.charCodeAt(first) <= 32) {
          first++;
        }
        const code = text.charCodeAt(first);
        if (last - first === 1 && (code === 0x2e || code === 0x2d)) {
          return '';
        }
        // Asterisks are what dBase writes when a number didn't fit into the field.
        if (code === 0x2a) {
          let i = first + 1;
          while (i < last && text.charCodeAt(i) === 0x2a) {
            i++;
          }
          if (i === last) {
            return '';
          }
        }
        return text.slice(first, last);
      }

      case DATE: {
        const first = at - base;
        let digits = 0;
        let zeros = 0;
        for (let i = first; i < first + 8; i++) {
          const code = text.charCodeAt(i);
          digits += code >= 0x30 && code <= 0x39 ? 1 : 0;
          zeros += code === 0x30 ? 1 : 0;
        }
        if (digits === 8) {
          // Eight zeros are how some programs write "no date".
          return zeros === 8 ? '' : `${text.slice(first, first + 4)}-${text.slice(first + 4, first + 6)}-${text.slice(first + 6, first + 8)}`;
        }
        return text.slice(first, first + 8).replace(/\0/g, ' ').trim();
      }

      case LOGICAL:
        switch (length ? bytes[at] : 0) {
          case 0x54: // T
          case 0x74:
          case 0x59: // Y
          case 0x79:
            return 'true';
          case 0x46: // F
          case 0x66:
          case 0x4e: // N
          case 0x6e:
            return 'false';
        }
        return '';

      case INTEGER: {
        if (!level7) {
          return String(view.getInt32(at, true));
        }
        // dBase 7 stores it so that the bytes sort like the numbers: most significant byte first and the sign bit turned over.
        const stored = view.getUint32(at, false);
        return stored ? String((stored ^ 0x80000000) | 0) : '';
      }

      case CURRENCY:
        return currency(view.getBigInt64(at, true));

      case DATETIME: {
        // A Julian day number and the milliseconds of the day. Visual FoxPro computes the latter
        // through a float and is often a millisecond off, so they are rounded to the second it means.
        const day = view.getUint32(at, true);
        const seconds = Math.round(view.getUint32(at + 4, true) / 1000);
        if (!day || seconds > 86400) {
          return '';
        }
        return seconds === 86400 ? dateTime(day + 1, 0) : dateTime(day, seconds);
      }

      case DOUBLE: {
        if (!level7) {
          return double(view.getFloat64(at, true));
        }
        const value = sortable(at);
        return value === undefined ? '' : double(value);
      }

      case STAMP: {
        // Milliseconds since the start of the day before January 1 of the year 1.
        const value = sortable(at);
        if (value === undefined || !(value >= 0 && value < 4e14)) {
          return '';
        }
        const day = Math.floor(value / 86400000);
        return dateTime(day + DAY_ONE, Math.floor((value - day * 86400000) / 1000));
      }

      case MEMO: {
        const number = block(at, length);
        return !number ? '' : memo ? memoText(number, memo) : '(memo)';
      }

      case BINARY:
        return block(at, length) ? '(binary)' : '';

      case VARCHAR:
      case VARBINARY: {
        // A value shorter than the field keeps its length in the last byte of the field.
        const short = flags && column.lengthBit >= 0 && (bytes[record + flags.offset + (column.lengthBit >> 3)] >> (column.lengthBit & 7)) & 1;
        const size = short ? Math.min(bytes[at + length - 1], length) : length;
        if (column.kind === VARBINARY) {
          return size ? '(binary)' : '';
        }
        return trimmed(at, at + size, false);
      }
    }
    return '';
  };

  const builder = new FlatBuilder();
  const limit = Math.min(MAX_ROWS, columns.length ? Math.floor(MAX_CELLS / columns.length) : MAX_ROWS);
  const perChunk = Math.max(1, Math.floor(CHUNK / recordLength));
  let records = 0;
  let deleted = 0;
  let rows = 0;
  let full = false;
  for (let first = 0; first < total; first += perChunk) {
    const last = Math.min(total, first + perChunk);
    if (!full) {
      base = start + first * recordLength;
      text = decode.aligned(bytes.subarray(base, start + last * recordLength));
    }
    for (let r = first; r < last; r++) {
      const record = start + r * recordLength;
      if (bytes[record] === 0x2a) {
        deleted++;
        continue;
      }
      // Past the limits the records are still counted, which takes one byte of each.
      records++;
      if (full) {
        continue;
      }
      if (rows >= limit || builder.chars > MAX_CHARS) {
        full = true;
        text = '';
        continue;
      }
      for (const column of columns) {
        builder.cell(cell(column, record));
      }
      builder.endRow();
      rows++;
    }
  }

  const count = (value: number) => value.toLocaleString('en-US');
  const warnings: string[] = [];
  if (total < header.count) {
    warnings.push(`The file is cut off: its header announces ${count(header.count)} record${header.count === 1 ? '' : 's'}, and ${count(total)} of them ${total === 1 ? 'is' : 'are'} there.`);
  }
  if (rows < records) {
    warnings.push(`Only the first ${count(rows)} of ${count(records)} records are shown.`);
  }
  if (hasMemo && sixMemo) {
    warnings.push('The memos of this table are in a format Previewix does not read (SMT).');
  } else if (hasMemo && !memo && options.memo) {
    warnings.push('The memo file next to the table is not one that belongs to it, so the memos are not shown.');
  }
  if (memosOutside) {
    warnings.push(`${memosOutside === 1 ? 'One memo points' : `${count(memosOutside)} memos point`} outside the memo file, which is damaged or belongs to another table.`);
  }
  if (memosCut) {
    warnings.push(`${memosCut === 1 ? 'One memo is' : `${count(memosCut)} memos are`} longer than 1 MB and shown in part.`);
  }
  if (choice.unknown) {
    warnings.push(`The code page the file names (${choice.unknown}) is not one Previewix knows, so it was guessed.`);
  }

  return {
    ...builder.finish(),
    names: columns.map((column) => decode.text(column.name).trimEnd()),
    types: columns.map((column) => column.type),
    details: columns.map((column) => column.detail),
    numeric: Uint8Array.from(columns, (column) => (column.numeric ? 1 : 0)),
    info: {
      format: FORMATS[header.version] ?? (level7 ? 'dBase 7' : 'dBase'),
      records,
      deleted,
      encoding: page.id,
      encodingLabel: page.label,
      encodingSource: choice.source,
      updated: header.updated,
      memo: !hasMemo ? 'none' : memo ? 'read' : 'missing',
      warning: warnings.length ? warnings.join(' ') : undefined,
    },
  };
}

if (!isMainThread && workerData?.previewixDbf) {
  try {
    const { bytes, ...options } = workerData.previewixDbf as DbfOptions & { bytes: Uint8Array };
    const dbf = readDbf(bytes, options);
    parentPort?.postMessage({ dbf }, [dbf.ends.buffer, dbf.rowEnds.buffer] as ArrayBuffer[]);
  } catch (e) {
    parentPort?.postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
}
