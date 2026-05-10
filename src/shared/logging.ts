export function logEvent(event: string, fields: Record<string, unknown> = {}) {
	const summaryFields = Object.entries(fields)
		.filter(([, value]) => value !== null && value !== undefined)
		.map(([key, value]) => `${key}=${String(value)}`)
		.join(" ");

	console.log(
		`${event}${summaryFields ? ` ${summaryFields}` : ""} ${JSON.stringify({
			event,
			...fields,
		})}`,
	);
}
