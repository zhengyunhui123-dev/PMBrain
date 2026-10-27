export const MAX_STREAMED_OFFICE_BYTES=512*1024**2;
export const LEGACY_OFFICE_BYTES=50*1024**2;
export function officeUploadCeiling(name:string){return /\.(?:docx|pptx|pdf|xlsx|xlsm|csv)$/i.test(name)?MAX_STREAMED_OFFICE_BYTES:LEGACY_OFFICE_BYTES;}
