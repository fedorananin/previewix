// pdf.js' viewer components read the core library from this global when they are evaluated,
// so this module has to be imported before 'pdfjs-dist/web/pdf_viewer.mjs'.
import * as pdfjsLib from 'pdfjs-dist';

globalThis.pdfjsLib = pdfjsLib;
