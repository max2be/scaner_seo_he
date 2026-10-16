export class SourceFailure extends Error {
  constructor(readonly code: string) { super(code); this.name = 'SourceFailure'; }
}
