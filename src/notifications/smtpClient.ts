import { connect } from "cloudflare:sockets";

export type SmtpEmail = {
	from: string;
	to: string;
	subject: string;
	text: string;
};

export type SmtpSendResult = {
	messageId: string;
	smtpAcceptedReply: string;
};

export type SmtpConfig = {
	host: string;
	port: number;
	username: string;
	password: string;
};

const SMTP_READ_TIMEOUT_MS = 15000;

function encodeBase64(value: string) {
	const bytes = new TextEncoder().encode(value);
	let binary = "";

	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

	return btoa(binary);
}

function normalizeRecipients(value: string) {
	return value
		.split(",")
		.map((recipient) => recipient.trim())
		.filter(Boolean);
}

function escapeHeaderValue(value: string) {
	return value.replace(/[\r\n]+/g, " ").trim();
}

function normalizeBody(value: string) {
	return value.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
}

function getMessageIdDomain(from: string) {
	const domain = from.split("@")[1]?.trim();

	return domain || "movieapp-cloudflare.local";
}

function buildMessage(email: SmtpEmail, messageId: string) {
	const recipients = normalizeRecipients(email.to);
	const headers = [
		`From: ${escapeHeaderValue(email.from)}`,
		`To: ${recipients.map(escapeHeaderValue).join(", ")}`,
		`Subject: ${escapeHeaderValue(email.subject)}`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: <${escapeHeaderValue(messageId)}>`,
		"MIME-Version: 1.0",
		'Content-Type: text/plain; charset="UTF-8"',
		"Content-Transfer-Encoding: 8bit",
	];

	return `${headers.join("\r\n")}\r\n\r\n${normalizeBody(email.text)}\r\n.`;
}

function parseReplyCode(reply: string) {
	const match = reply.match(/^(\d{3})/m);

	return match ? Number(match[1]) : null;
}

function isReplyComplete(reply: string) {
	const lines = reply.split(/\r?\n/).filter(Boolean);

	if (lines.length === 0) {
		return false;
	}

	const lastLine = lines[lines.length - 1];

	return /^\d{3} /.test(lastLine);
}

function assertReply(reply: string, expectedCodes: number[], commandName: string) {
	const code = parseReplyCode(reply);

	if (code === null || !expectedCodes.includes(code)) {
		throw new Error(
			`SMTP ${commandName} failed: expected ${expectedCodes.join(
				"/",
			)}, received ${reply.trim()}`,
		);
	}
}

class SmtpConnection {
	private readonly decoder = new TextDecoder();
	private readonly encoder = new TextEncoder();
	private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
	private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

	constructor(private readonly socket: Socket) {
		this.writer = socket.writable.getWriter();
		this.reader = socket.readable.getReader();
	}

	async readReply() {
		let reply = "";
		const timeout = new Promise<never>((_, reject) => {
			setTimeout(
				() => reject(new Error("SMTP read timed out.")),
				SMTP_READ_TIMEOUT_MS,
			);
		});

		while (!isReplyComplete(reply)) {
			const result = await Promise.race([this.reader.read(), timeout]);

			if (result.done) {
				break;
			}

			reply += this.decoder.decode(result.value, { stream: true });
		}

		return reply;
	}

	async command(command: string, expectedCodes: number[], commandName = command) {
		await this.writer.write(this.encoder.encode(`${command}\r\n`));
		const reply = await this.readReply();
		assertReply(reply, expectedCodes, commandName);

		return reply;
	}

	async close() {
		this.reader.releaseLock();
		this.writer.releaseLock();
		await this.socket.close();
	}
}

export async function sendSmtpEmail(
	config: SmtpConfig,
	email: SmtpEmail,
): Promise<SmtpSendResult> {
	const recipients = normalizeRecipients(email.to);

	if (recipients.length === 0) {
		throw new Error("No SMTP email recipients configured.");
	}

	const messageId = `movieapp-${Date.now()}-${crypto.randomUUID()}@${getMessageIdDomain(
		email.from,
	)}`;

	const socket = connect(
		{
			hostname: config.host,
			port: config.port,
		},
		{
			allowHalfOpen: false,
			secureTransport: "on",
		},
	);
	const connection = new SmtpConnection(socket);

	try {
		assertReply(await connection.readReply(), [220], "connect");
		await connection.command("EHLO movieapp-cloudflare", [250], "EHLO");
		await connection.command("AUTH LOGIN", [334], "AUTH LOGIN");
		await connection.command(
			encodeBase64(config.username),
			[334],
			"AUTH username",
		);
		await connection.command(
			encodeBase64(config.password),
			[235],
			"AUTH password",
		);
		await connection.command(`MAIL FROM:<${email.from}>`, [250], "MAIL FROM");

		for (const recipient of recipients) {
			await connection.command(`RCPT TO:<${recipient}>`, [250, 251], "RCPT TO");
		}

		await connection.command("DATA", [354], "DATA");
		const smtpAcceptedReply = await connection.command(
			buildMessage(email, messageId),
			[250],
			"message body",
		);
		await connection.command("QUIT", [221], "QUIT");

		return {
			messageId,
			smtpAcceptedReply: smtpAcceptedReply.trim(),
		};
	} finally {
		await connection.close();
	}
}
