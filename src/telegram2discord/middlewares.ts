import R from "ramda";
import { Bridge } from "../bridgestuff/Bridge";
import mime from "mime/lite";
import { handleEntities } from "./handleEntities";
import Discord, { Client } from "discord.js";
import { sleepOneMinute } from "../sleep";
import { fetchDiscordChannel } from "../fetchDiscordChannel";
import { Message } from "telegraf/typings/core/types/typegram";
import { TediCrossContext } from "./endwares";
import { createFromObjFromChat, createFromObjFromMessage, createFromObjFromUser, makeDisplayName } from "./From";
import { deleteMessage, ignoreAlreadyDeletedError } from "./helpers";
import { MessageMap } from "../MessageMap";

/***********
 * Helpers *
 ***********/

/**
 * Creates a text object from a Telegram message
 *
 * @param message The message object
 * @param ctx The TediCrossContext object
 *
 * @returns The text object, or undefined if no text was found
 */
function createTextObjFromMessage(ctx: TediCrossContext, message: Message) {
	return R.cond<any, any>([
		// Text
		[
			R.has("text"),
			({ text, entities }) => ({
				raw: text,
				entities: R.defaultTo([], entities)
			})
		],
		// Animation, audio, document, photo, video or voice
		[
			R.has<any>("caption"),
			({ caption, caption_entities }: { caption: string; caption_entities: string }) => ({
				raw: caption,
				entities: R.defaultTo([], caption_entities)
			})
		],
		// Stickers have an emoji instead of text
		[
			R.has("sticker"),
			message => ({
				raw: R.ifElse<any, any, any>(
					() => ctx.TediCross.settings.telegram.sendEmojiWithStickers,
					R.path(["sticker", "emoji"]),
					R.always("")
				)(message),
				entities: []
			})
		],
		// Locations must be turned into a URL
		[
			R.has<any>("location"),
			({ location }: any) => ({
				raw: `https://maps.google.com/maps?q=${location.latitude},${location.longitude}&ll=${location.latitude},${location.longitude}&z=16`,
				entities: []
			})
		],
		// Default to undefined
		[R.T, R.always({ raw: "", entities: [] })]
	])(message);
}

/**
 * Makes the reply text to show on Discord
 *
 * @param replyTo The replyTo object from the tediCross context
 * @param replyLength How many characters to take from the original
 * @param maxReplyLines How many lines to cut the reply text after
 *
 * @returns The reply text to display
 */
const makeReplyText = (replyTo: any, replyLength: number, maxReplyLines: number) => {
	const countDoublePipes = R.tryCatch(str => str.match(/\|\|/g).length, R.always(0));

	// Make the reply string
	return R.compose<any, any>(
		// Add ellipsis if the text was cut
		R.ifElse(R.compose(R.equals(R.length(replyTo.text.raw)), R.length), R.identity, R.concat(R.__, "…")),
		// Handle spoilers (pairs of "||" in Discord)
		//@ts-ignore
		R.ifElse<any, any, any>(
			// If one of a pair of "||" has been removed
			quote =>
				R.and(
					//@ts-ignore
					countDoublePipes(quote, "||") % 2 === 1,
					countDoublePipes(replyTo.text.raw) % 2 === 0
				),
			// Add one to the end
			R.concat(R.__, "||"),
			// Otherwise do nothing
			R.identity
		),
		// Take only a number of lines
		R.join("\n"),
		R.slice(0, maxReplyLines),
		R.split("\n"),
		// Take only a portion of the text
		R.slice(0, replyLength)
	)(replyTo.text.raw);
};

/**
 * Makes a discord mention out of a username
 *
 * @param username The username to make the mention from
 * @param dcBot The Discord bot to look up the user's ID with
 * @param bridge The bridge to use
 *
 * @returns A Discord mention of the user
 */
async function makeDiscordMention(username: string, dcBot: Client, bridge: Bridge) {
	try {
		// Get the name of the Discord user this is a reply to
		const channel = await fetchDiscordChannel(dcBot, bridge);
		const dcUser = await channel.members.find(R.propEq(username, "displayName"));

		return dcUser ? `<@${dcUser.id}>` : username;
	} catch (err) {
		// Cannot make a mention. Just return the username
		return username;
	}
}

/****************************
 * The middleware functions *
 ****************************/

/**
 * Adds a `tediCross` property to the context
 *
 * @param ctx The context to add the property to
 * @param next Function to pass control to next middleware
 */
function addTediCrossObj(ctx: TediCrossContext, next: () => void) {
	ctx.tediCross = {} as any;
	next();
}

/**
 * Adds a message object to the tediCross context. One of the four optional arguments must be present. Requires the tediCross context to work
 *
 * @param ctx The Telegraf context
 * @param ctx.tediCross The TediCross object on the context
 * @param [ctx.channelPost]
 * @param [ctx.editedChannelPost]
 * @param [ctx.message]
 * @param [ctx.editedChannelPost]
 * @param next Function to pass control to next middleware
 */
function addMessageObj(ctx: TediCrossContext, next: () => void) {
	// Put it on the context
	// bypass pinned message notification
	if (
		(ctx as any).update.message &&
		((ctx as any).update.message.pinned_message ||
			(ctx as any).update.message.forum_topic_closed ||
			(ctx as any).update.message.forum_topic_reopened)
	) {
		return;
	}

	ctx.tediCross.message = R.cond([
		// XXX I tried both R.has and R.hasIn as conditions. Neither worked for some reason
		[ctx => !R.isNil((ctx as any).update.channel_post), R.path(["update", "channel_post"])],
		[ctx => !R.isNil((ctx as any).update.edited_channel_post), R.path(["update", "edited_channel_post"])],
		[ctx => !R.isNil((ctx as any).update.message), R.path(["update", "message"])],
		[ctx => !R.isNil((ctx as any).update.edited_message), R.path(["update", "edited_message"])]
	])(ctx) as any;

	next();
}

/**
 * Adds the message ID as a prop to the tedicross context
 *
 * @param ctx The Telegraf context
 * @param ctx.tediCross The Tedicross object on the context
 * @param ctx.tediCross.message The message object being handled
 * @param next Function to pass control to next middleware
 */
function addMessageId(ctx: TediCrossContext, next: () => void) {
	if (ctx.tediCross.message && ctx.tediCross.message.message_id) {
		ctx.tediCross.messageId = ctx.tediCross.message.message_id;

		next();
	} else {
		console.error("Unsupported telegram message type");
	}
}

/**
 * Adds the bridges to the tediCross object on the context. Requires the tediCross context to work
 *
 * @param ctx The context to add the property to
 * @param ctx.tediCross The TediCross object on the context
 * @param ctx.TediCross The global TediCross context
 * @param ctx.TediCross.bridgeMap The bridge map of the application
 * @param next Function to pass control to next middleware
 */
function addBridgesToContext(ctx: TediCrossContext, next: () => void) {
	ctx.tediCross.bridges = ctx.TediCross.bridgeMap.fromTelegramChatId(ctx.tediCross.message.chat.id);

	next();
}

/**
 * Removes d2t bridges from the bridge list
 *
 * @param ctx The Telegraf context to use
 * @param ctx.tediCross The TediCross object on the context
 * @param ctx.tediCross.bridges The bridges the message could use
 * @param next Function to pass control to next middleware
 */
function removeD2TBridges(ctx: TediCrossContext, next: () => void) {
	ctx.tediCross.bridges = R.reject(R.propEq(Bridge.DIRECTION_DISCORD_TO_TELEGRAM, "direction"))(
		ctx.tediCross.bridges
	);

	next();
}

// THIS BREAKS THE BOT
/**
 * Removes bridges with the `relayCommands` flag set to false from the bridge list
 *
 * @param ctx The Telegraf context to use
 * @param ctx.tediCross The TediCross object on the context
 * @param ctx.tediCross.bridges The bridges the message could use
 * @param next Function to pass control to next middleware
 */
function removeBridgesIgnoringCommands(ctx: TediCrossContext, next: () => void) {
	//@ts-ignore
	ctx.tediCross.bridges = R.filter<any, any>(R.path(["telegram", "relayCommands"]), ctx.tediCross.bridges);
	next();
}

/**
 * Removes bridges with `telegram.relayJoinMessages === false`
 *
 * @param ctx The Telegraf context to use
 * @param ctx.tediCross The TediCross object on the context
 * @param ctx.tediCross.bridges The bridges the message could use
 * @param next Function to pass control to next middleware
 */
function removeBridgesIgnoringJoinMessages(ctx: TediCrossContext, next: () => void) {
	//@ts-ignore
	ctx.tediCross.bridges = R.filter(R.path(["telegram", "relayJoinMessages"]), ctx.tediCross.bridges);
	next();
}

/**
 * Removes bridges with `telegram.relayLeaveMessages === false`
 *
 * @param ctx The Telegraf context to use
 * @param ctx.tediCross The TediCross object on the context
 * @param ctx.tediCross.bridges The bridges the message could use
 * @param next Function to pass control to next middleware
 */
function removeBridgesIgnoringLeaveMessages(ctx: TediCrossContext, next: () => void) {
	//@ts-ignore
	ctx.tediCross.bridges = R.filter(R.path(["telegram", "relayLeaveMessages"]), ctx.tediCross.bridges);
	next();
}

/**
 * Replies to the message telling the user this is a private bot if there are no bridges on the tediCross context
 *
 * @param ctx The Telegraf context
 * @param ctx.reply The context's reply function
 * @param next Function to pass control to next middleware
 */


/**
 * Adds a `from` object to the tediCross context
 *
 * @param ctx The context to add the property to
 * @param ctx.tediCross The tediCross on the context
 * @param ctx.tediCross.message The message object to create the `from` object from
 * @param next Function to pass control to next middleware
 */
function addFromObj(ctx: TediCrossContext, next: () => void) {
	ctx.tediCross.from = createFromObjFromMessage(ctx.tediCross.message);
	next();
}

/**
 * Adds a `reply` object to the tediCross context, if the message is a reply
 *
 * @param ctx The context to add the property to
 * @param ctx.tediCross The tediCross on the context
 * @param ctx.tediCross.message The message object to create the `reply` object from
 * @param next Function to pass control to next middleware
 */
function addReplyObj(ctx: TediCrossContext, next: () => void) {
	// const repliedToMessage = ctx.tediCross.message.reply_to_message;

	const repliedToMessage = ctx.tediCross.message?.message_thread_id
		? ctx.tediCross.message?.message_thread_id !== ctx.tediCross.message?.reply_to_message?.message_id
			? ctx.tediCross.message?.reply_to_message
			: ctx.tediCross.message?.reply_to_message?.message_thread_id
			? undefined
			: ctx.tediCross.message?.reply_to_message
		: ctx.tediCross.message?.reply_to_message;

	// console.log(`repliedToMessage: ${repliedToMessage}`);
	// console.dir(ctx.tediCross.message);

	if (!R.isNil(repliedToMessage)) {
		// This is a reply
		const isReplyToTediCross =
			// @ts-ignore
			!R.isNil(repliedToMessage.from) && R.equals(repliedToMessage.from.id, ctx.TediCross.me.id);
		ctx.tediCross.replyTo = {
			isReplyToTediCross,
			message: repliedToMessage,
			originalFrom: createFromObjFromMessage(repliedToMessage),
			text: createTextObjFromMessage(ctx, repliedToMessage)
		};

		// Handle replies to TediCross
		if (isReplyToTediCross) {
			// Get the username of the Discord user who sent this and remove it from the text
			const split = R.split("\n", ctx.tediCross.replyTo.text.raw);
			ctx.tediCross.replyTo.dcUsername = R.head(split);
			ctx.tediCross.replyTo.text.raw = R.join("\n", R.tail(split));

			// Cut off the first entity (the bold text on the username) and reduce the offset of the rest by the length of the username and the newline
			ctx.tediCross.replyTo.text.entities = R.compose(
				R.map((entity: any) =>
					R.mergeRight(entity, {
						offset: entity.offset - ctx.tediCross.replyTo.dcUsername.length - 1
					})
				),
				R.tail
			)(ctx.tediCross.replyTo.text.entities);
		}

		// Turn the original text into "<no text>" if there is no text
		if (R.isEmpty(ctx.tediCross.replyTo.text.raw)) {
			ctx.tediCross.replyTo.text.raw = "<no text>";
		}
	}

	next();
}

/**
 * Adds a `forward` object to the tediCross context, if the message is a forward
 *
 * @param ctx	The context to add the property to
 * @param ctx.tediCross	The tediCross on the context
 * @param ctx.tediCross.message	The message object to create the `forward` object from
 * @param next	Function to pass control to next middleware
 */
function addForwardFrom(ctx: TediCrossContext, next: () => void) {
	const msg = ctx.tediCross.message;

	if (!R.isNil(msg.forward_from) || !R.isNil(msg.forward_from_chat)) {
		ctx.tediCross.forwardFrom = R.ifElse(
			// If there is no `forward_from` prop
			R.compose(R.isNil, R.prop("forward_from")),
			// Then this is a forward from a chat (channel)
			//@ts-ignore
			R.compose<any, any>(createFromObjFromChat, R.prop("forward_from_chat")),
			// Else it is from a user
			//@ts-ignore
			R.compose(createFromObjFromUser, R.prop("forward_from"))
		)(msg);
	}

	next();
}

/**
 * Adds a text object to the tediCross property on the context, if there is text in the message
 *
 * @param ctx	The context to add the property to
 * @param ctx.tediCross	The tediCross on the context
 * @param ctx.tediCross.message	The message object to get the text data from
 * @param next	Function to pass control to next middleware
 */
function addTextObj(ctx: TediCrossContext, next: () => void) {
	const text = createTextObjFromMessage(ctx, ctx.tediCross.message as any);
	if (!R.isNil(text)) {
		ctx.tediCross.text = text;
	}

	next();
}

/**
 * Adds a file object to the tediCross property on the context
 *
 * @param ctx The context to add the property to
 * @param ctx.tediCross The tediCross on the context
 * @param ctx.tediCross.message The message object to get the file data from
 * @param next Function to pass control to next middleware
 */
function addFileObj(ctx: TediCrossContext, next: () => void) {
	const message = ctx.tediCross.message;

	// Figure out if a file is present
	if (!R.isNil(message.audio)) {
		// Audio
		ctx.tediCross.file = {
			type: "audio",
			id: message.audio.file_id,
			name: message.audio.title + "." + mime.getExtension(message.audio.mime_type)
		};
	} else if (!R.isNil(message.document)) {
		// Generic file
		ctx.tediCross.file = {
			type: "document",
			id: message.document.file_id,
			name: message.document.file_name
		};
	} else if (!R.isNil(message.photo)) {
		// Photo. It has an array of photos of different sizes. Use the last and biggest
		const photo = R.last(message.photo) as any;
		ctx.tediCross.file = {
			type: "photo",
			id: photo.file_id,
			name: "photo.jpg" // Telegram will convert it to a jpg no matter which format is originally sent
		};
	} else if (!R.isNil(message.sticker)) {
		// Sticker
		ctx.tediCross.file = {
			type: "sticker",
			id: R.ifElse(
				R.propEq(true, "is_animated"),
				R.path(["thumb", "file_id"]),
				R.prop<any>("file_id")
			)(message.sticker),
			name: "sticker.webp"
		};
	} else if (!R.isNil(message.video)) {
		// Video
		ctx.tediCross.file = {
			type: "video",
			id: message.video.file_id,
			name: message.video.file_name || `video.${mime.getExtension(message.video.mime_type)}`
		};
	} else if (!R.isNil(message.voice)) {
		// Voice
		ctx.tediCross.file = {
			type: "voice",
			id: message.voice.file_id,
			name: "voice" + "." + mime.getExtension(message.voice.mime_type)
		};
	}

	next();
}

/**
 * Adds a file link to the file object on the tedicross context, if there is one
 *
 * @param ctx The context to add the property to
 * @param ctx.tediCross The tediCross on the context
 * @param next Function to pass control to next middleware
 *
 * @returns Promise resolving to nothing when the operation is complete
 */
function addFileLink(ctx: TediCrossContext, next: () => void) {
	return Promise.resolve()
		.then(() => {
			// Get a stream to the file, if one was found
			if (!R.isNil(ctx.tediCross.file)) {
				return ctx.telegram.getFileLink(ctx.tediCross.file.id).then(fileLink => {
					ctx.tediCross.file.link = fileLink.href;
					if (ctx.tediCross.file.type === "photo") {
						ctx.tediCross.file.name = fileLink.href.split("/").pop() || ctx.tediCross.file.name;
					}
				});
			}
		})
		.then(next)
		.then(R.always(undefined))
		.catch(err => {
			if (ctx.TediCross.settings.telegram.suppressFileTooBigMessages) {
				console.log(err.response ? err.response.description : "Bad Request");
			} else if (err.response && err.response.description === "Bad Request: file is too big") {async function addPreparedObj(ctx: TediCrossContext, next: () => void) {
	// Shorthand para el contexto de TediCross
	const tc = ctx.tediCross;

	ctx.tediCross.prepared = await Promise.all(
		R.map(async (bridge: Bridge) => {
			// Esperar que el bot de Discord esté listo
			await ctx.TediCross.dcBot.ready;

			// Obtener el canal de Discord donde se enviará el mensaje
			const channel = await fetchDiscordChannel(
				ctx.TediCross.dcBot,
				bridge,
				ctx.tediCross.message?.message_thread_id
			);

			// Obtener el nombre del remitente
			const senderName = makeDisplayName(ctx.TediCross.settings.telegram.useFirstNameInsteadOfUsername, tc.from);

			// Verificar si el mensaje es una respuesta a otro
			let replyId = "0";
			let messageToReply: any;
			const messageReference = ctx.tediCross.message?.reply_to_message;

			if (messageReference) {
				const referenceId = messageReference?.message_id;
				if (referenceId) {
					[replyId] = await ctx.TediCross.messageMap.getCorrespondingReverse(
						MessageMap.DISCORD_TO_TELEGRAM,
						bridge,
						referenceId as string
					);

					if (replyId === undefined) {
						[replyId] = await ctx.TediCross.messageMap.getCorresponding(
							MessageMap.TELEGRAM_TO_DISCORD,
							bridge,
							referenceId as string
						);
					}
				}
			}

			if (replyId !== "0" && replyId !== undefined) {
				messageToReply = await channel.messages.fetch(replyId).catch(() => undefined);
			}

			if (messageToReply) {
				ctx.tediCross.hasActualReference = true;
			}

			// Crear encabezado con Markdown
			const header = `📢 **Mensaje desde Telegram**`;
			const senderFormatted = `👤 **${senderName}**`;

			// Formatear el texto del mensaje con Markdown
			const formattedMessage = `---
${header}

${senderFormatted}:
\`\`\`
${tc.text.raw}
\`\`\`
📅 _${new Date().toLocaleString()}_
---
`;

			// Enviar el mensaje a Discord
			if (messageToReply) {
				channel.send({ content: formattedMessage, reply: { messageReference: messageToReply } });
			} else {
				channel.send(formattedMessage);
			}

			return {
				bridge,
				header,
				senderName,
				text: formattedMessage,
				messageToReply,
				replyId
			};
		}, tc.bridges)
	);

	next();
}

				ctx.reply(`<i>File '${ctx.tediCross.file.name}' is too big for TediCross to handle</i>`, {
					parse_mode: "HTML"
				}).then();
			}

			next();
		});
}



/***************
 * Export them *
 ***************/

export default {
	addTediCrossObj,
	addMessageObj,
	addMessageId,
	addBridgesToContext,
	removeD2TBridges,
	removeBridgesIgnoringCommands,
	removeBridgesIgnoringJoinMessages,
	removeBridgesIgnoringLeaveMessages,
	/*informThisIsPrivateBot,*/
	addFromObj,
	addReplyObj,
	addForwardFrom,
	addTextObj,
	addFileObj,
	addFileLink,
	addPreparedObj
};
