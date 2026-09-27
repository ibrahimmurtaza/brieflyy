/**
 * Service classes that exist in the codebase but that the application factory
 * does not construct yet.
 *
 * The reachability guard in `src/app-wiring.test.ts` fails the build for any
 * service class that is neither constructed by `createApp` nor listed here, so
 * an unwired service cannot be added silently. Each entry names the ticket that
 * wires the service; the list shrinks to empty as those tickets land.
 */
export const DEFERRED_SERVICES: Readonly<Record<string, string>> = {
  ArchiveSearchService: '#49',
  BriefPlanService: '#40',
  ClusterFormationService: '#37',
  DiscoverService: '#47',
  FeedbackService: '#45',
  OpenAILLMSummaryService: '#44',
  ScheduledBriefService: '#42',
  TrendsService: '#48',
};
