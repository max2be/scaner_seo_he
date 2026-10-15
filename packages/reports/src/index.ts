export interface ReportWriter { write(projectId:string,scanId:string):Promise<void>; }
// Reports/diff are EPIC-06.
