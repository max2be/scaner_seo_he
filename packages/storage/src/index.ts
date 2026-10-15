export interface ScanStorage { readManifest(projectId:string,scanId:string):Promise<unknown>; }
// Atomic journal/checkpoint is EPIC-04.
