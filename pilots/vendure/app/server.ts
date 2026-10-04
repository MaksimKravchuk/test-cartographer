import { bootstrap, JobQueueService } from '@vendure/core';
import { config } from './vendure-config.ts';

const app = await bootstrap(config);
// One process for API and jobs (search index, emails): good enough for a pilot.
await app.get(JobQueueService).start();
