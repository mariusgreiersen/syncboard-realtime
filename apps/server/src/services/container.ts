import type { AppConfig } from '../config/env.js';
import type { Database } from '../database/client.js';
import { AuthService } from '../auth/authService.js';
import { SessionStore } from '../auth/sessions.js';
import type { Log } from '../lib/logger.js';
import { ActivityService } from '../modules/activity/activityService.js';
import { BoardService } from '../modules/boards/boardService.js';
import { ColumnService } from '../modules/columns/columnService.js';
import { DemoService } from '../modules/demo/demoService.js';
import { MemberService } from '../modules/members/memberService.js';
import { PublisherRef } from '../modules/mutations/publisher.js';
import { TaskService } from '../modules/tasks/taskService.js';

/** Hooks the HTTP layer uses to reach the realtime layer (set once Socket.IO is attached). */
export interface RealtimeHooks {
  disconnectSession(sessionId: string): void;
}

export interface Services {
  db: Database;
  config: AppConfig;
  publisher: PublisherRef;
  realtime: RealtimeHooks;
  sessions: SessionStore;
  auth: AuthService;
  boards: BoardService;
  tasks: TaskService;
  members: MemberService;
  columns: ColumnService;
  activity: ActivityService;
  demo: DemoService;
}

export function createServices(db: Database, config: AppConfig, log: Log): Services {
  const publisher = new PublisherRef();
  return {
    db,
    config,
    publisher,
    realtime: { disconnectSession: () => undefined },
    sessions: new SessionStore(db, config.SESSION_TTL_HOURS * 3_600_000),
    auth: new AuthService(db, { demoMode: config.DEMO_MODE }),
    boards: new BoardService(db, publisher, log),
    tasks: new TaskService(db, publisher, log),
    members: new MemberService(db, publisher, log),
    columns: new ColumnService(db, publisher),
    activity: new ActivityService(db),
    demo: new DemoService(db, publisher, log),
  };
}
