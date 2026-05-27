import { ch, chQuery, TABLE_NAMES } from '@openpanel/db';
import { getLock } from '@openpanel/redis';

import { logger } from '../utils/logger';

const PROJECT_IDS = ['dashreels', 'shortreels'];
const BATCH_SIZE = 10_000;
const DEDUP_TABLE = 'first_event_dedup';

type Candidate = {
  profile_id: string;
  project_id: string;
  first_ts: string;
};

export async function firstEvent() {
  const lock = await getLock('firstEvent:lock', '1', 55 * 60 * 1000);
  if (!lock) {
    logger.info('[first-event] Skipping — another instance is already running');
    return;
  }

  try {
    const projectList = PROJECT_IDS.map((p) => `'${p}'`).join(', ');

    const candidates = await chQuery<Candidate>(`
      SELECT
        candidates.profile_id,
        candidates.project_id,
        toString(candidates.first_ts) AS first_ts
      FROM (
        SELECT
          profile_id,
          project_id,
          minMerge(first_event_time) AS first_ts
        FROM ${TABLE_NAMES.profile_event_summary_mv}
        WHERE project_id IN (${projectList})
          AND event_date >= today() - 7
        GROUP BY profile_id, project_id
        HAVING countIf(name = '_first_event') = 0
      ) AS candidates
      LEFT ANTI JOIN ${DEDUP_TABLE} AS d
        ON candidates.project_id = d.project_id
        AND candidates.profile_id = d.profile_id
      SETTINGS max_execution_time = 60
    `);

    if (candidates.length === 0) {
      logger.info('[first-event] No new profiles to process');
      return;
    }

    logger.info(`[first-event] Found ${candidates.length} profiles to insert`);

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);

      await ch.insert({
        table: TABLE_NAMES.events,
        values: batch.map((c) => ({
          name: '_first_event',
          profile_id: c.profile_id,
          device_id: '',
          project_id: c.project_id,
          session_id: '',
          created_at: c.first_ts,
          properties: JSON.stringify({ is_synthetic: 'true' }),
          os: '',
          os_version: '',
          country: '',
          city: '',
          region: '',
          device: '',
          brand: '',
          model: '',
          sdk_name: 'cron',
          sdk_version: '1.0.0',
        })),
        format: 'JSONEachRow',
      });

      logger.info(
        `[first-event] Inserted batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(candidates.length / BATCH_SIZE)}`,
      );
    }

    logger.info(
      `[first-event] Done — inserted _first_event for ${candidates.length} profiles`,
    );
  } catch (error) {
    logger.error('[first-event] Error:', error);
    throw error;
  }
}
