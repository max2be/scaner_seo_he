import type { RuleProfile, PageObservation, TitleGroup, DiscoverySummary, Provenance } from '@hsi/contracts';
export interface AnalysisContext {
  profile: RuleProfile;
  indexableExpected?: boolean;
  observation: PageObservation;
  coverage: Pick<DiscoverySummary, 'sitemapComplete' | 'backendComplete' | 'snapshotConsistency'>;
  titleGroup?: TitleGroup;
  provenance?: Provenance;
}
