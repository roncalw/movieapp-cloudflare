import { handleFetch } from "./httpRouting/httpRoutes";
import { handleQueue } from "./jobs/queueHandler";
import { handleScheduled } from "./jobs/scheduled";
import type { Env, WorkerQueueMessage } from "./shared/types";

export type { Env } from "./shared/types";

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx?: ExecutionContext,
	): Promise<Response> {
		return handleFetch(request, env, ctx);
	},

	async queue(
		batch: MessageBatch<WorkerQueueMessage>,
		env: Env,
	): Promise<void> {
		await handleQueue(batch, env);
	},

	async scheduled(
		controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		handleScheduled(controller, env, ctx);
	},
} satisfies ExportedHandler<Env, WorkerQueueMessage>;
