import R from "ramda";
import { MessageMap } from "../MessageMap";
import { sleepOneMinute } from "../sleep";
import { fetchDiscordChannel } from "../fetchDiscordChannel";
import { Context } from "telegraf";
import { deleteMessage, ignoreAlreadyDeletedError } from "./helpers";
import { createFromObjFromUser } from "./From";
import { MessageEditOptions, EmbedBuilder } from "discord.js";
import { Message, User } from "telegraf/typings/core/types/typegram";

interface DiscordMessage {
	embeds?: any[];
	content?: string;
	files?: any[];
}

export interface TediCrossContext extends Context {
    TediCross: any;
    tediCross: {
        message: Message | any;
        file: {
            type: string;
            id: string;
            name: string;
            link?: string;
        };
        messageId: string;
        prepared: any;
        bridges: any;
        replyTo: any;
        text: any;
        forwardFrom: any;
        from: any;
        hasActualReference: boolean;
        hasMediaGroup?: boolean;
        discordChannelId?: string;  
        alreadyProcessed?: boolean;  // ✅ Agregar esta línea
    };
}


/***********
 * Helpers *
 ***********/

/**
 * Makes an endware function be handled by all bridges it applies to. Curried
 *
 * @param func	The message handler to wrap
 * @param ctx	The Telegraf context
 */
const createMessageHandler = R.curry((func, ctx) => {
	// Wait for the Discord bot to become ready
	ctx.TediCross.dcBot.ready.then(() => R.forEach(bridge => func(ctx, bridge))(ctx.tediCross.bridges));
});

/*************************
 * The endware functions *
 *************************/

/**
 * Replies to a message with info about the chat for channels.
 *
 * @param ctx	The Telegraf context
 */
export const channelChatInfo = (ctx: Context, next: () => void) => {
	if ((ctx as any).update?.channel_post) {
		if ((ctx as any).update.channel_post.text?.indexOf("/chatinfo") === 0) {
			ctx.reply(`chatID: ${(ctx as any).update.channel_post.chat.id}`)
				// Wait some time
				.then(sleepOneMinute)
				// Delete the info and the command
				.then(message =>
					Promise.all([
						// Delete the info
						deleteMessage(ctx, message),
						// Delete the command
						ctx.deleteMessage()
					])
				)
				.catch(ignoreAlreadyDeletedError as any);
			return;
		}
	}
	next();
};

/**
 * Replies to a command with info about the chat
 *
 * @param ctx	The Telegraf context
 */
export const chatinfo = (ctx: Context) => {
	// Reply with the info
	ctx.reply(`chatID: ${ctx.message?.chat.id}`)
		// Wait some time
		.then(sleepOneMinute)
		// Delete the info and the command
		.then(message =>
			Promise.all([
				// Delete the info
				deleteMessage(ctx, message),
				// Delete the command
				ctx.deleteMessage()
			])
		)
		.catch(ignoreAlreadyDeletedError as any);
};

/**
 * Replies to a command with info about the thread
 *
 * @param ctx	The Telegraf context
 */
export const threadinfo = (ctx: Context) => {
	// Reply with the info
	if (ctx.message?.message_thread_id) {
		ctx.reply(`chatID: ${ctx.message.chat?.id}\nthreadID: ${ctx.message.message_thread_id}`)
			// Wait some time
			.then(sleepOneMinute)
			// Delete the info and the command
			.then(message =>
				Promise.all([
					// Delete the info
					deleteMessage(ctx, message),
					// Delete the command
					ctx.deleteMessage()
				])
			)
			.catch(ignoreAlreadyDeletedError as any);
	} else {
		ctx.reply(`Unable to detect threadID - call /threadinfo command from target thread's chat`)
			// Wait some time
			.then(sleepOneMinute)
			// Delete the info and the command
			.then(message =>
				Promise.all([
					// Delete the info
					deleteMessage(ctx, message),
					// Delete the command
					ctx.deleteMessage()
				])
			)
			.catch(ignoreAlreadyDeletedError as any);
	}
};

/**
 * Handles users joining chats
 *
 * @param ctx The Telegraf context
 * @param ctx.tediCross.message The Telegram message received
 * @param ctx.tediCross.message.new_chat_members List of the users who joined the chat
 * @param ctx.TediCross The global TediCross context of the message
 */
export const newChatMembers = createMessageHandler((ctx: TediCrossContext, bridge: any) =>
	// Notify Discord about each user
	R.forEach(user => {
		// Make the text to send
		const from = createFromObjFromUser(user as User);
		const text = `**${from.firstName} (${R.defaultTo(
			"No username",
			from.username
		)})** joined the Telegram side of the chat`;

		// Pass it on
		ctx.TediCross.dcBot.ready
			.then(() => fetchDiscordChannel(ctx.TediCross.dcBot, bridge).then((channel: any) => channel.send(text)))
			.catch((err: any) =>
				ctx.TediCross.logger.error(
					`Could not tell Discord about a new chat member on bridge ${bridge.name}: ${err.message}`
				)
			);
	})(ctx.tediCross.message.new_chat_members)
);

/**
 * Handles users leaving chats
 *
 * @param ctx The Telegraf context
 * @param ctx.tediCross The TediCross context of the message
 * @param ctx.tediCross.message The Telegram message received
 * @param ctx.tediCross.message.left_chat_member The user object of the user who left
 * @param ctx.TediCross The global TediCross context of the message
 */
export const leftChatMember = createMessageHandler((ctx: TediCrossContext, bridge: any) => {
	// Make the text to send
	const from = createFromObjFromUser(ctx.tediCross.message.left_chat_member);
	const text = `**${from.firstName} (${R.defaultTo(
		"No username",
		from.username
	)})** left the Telegram side of the chat`;

	// Pass it on
	ctx.TediCross.dcBot.ready
		.then(() => fetchDiscordChannel(ctx.TediCross.dcBot, bridge).then(channel => channel.send(text)))
		.catch((err: any) =>
			ctx.TediCross.logger.error(
				`Could not tell Discord about a chat member who left on bridge ${bridge.name}: ${err.message}`
			)
		);
});

const parseMediaGroup = (ctx: TediCrossContext, byTimer: boolean = false) => {
	//ctx.TediCross.logger.info(ctx.tediCross.message.media_group_id, byTimer);

	const groupIdMap = ctx.TediCross.groupIdMap;
	const groupId = ctx.tediCross.message.media_group_id;

	if (byTimer) {
		if (groupIdMap.has(groupId)) {
			const ctxArray = groupIdMap.get(groupId);
			groupIdMap.delete(groupId);
			if (ctxArray) {
				//ctx.TediCross.logger.info(`Array Length: ${ctxArray.length}`);
				const comboCtx: TediCrossContext = ctxArray[0];
				comboCtx.tediCross.hasMediaGroup = true;
				const prepared = comboCtx.tediCross.prepared[0];
				prepared.files = [];

				for (const lCtx of ctxArray) {
					const lPrepared = lCtx.tediCross.prepared[0];
					if (lPrepared.header) {
						prepared.header = lPrepared.header;
					}
					if (lPrepared.hasLinks) {
						prepared.hasLinks = lPrepared.hasLinks;
					}
					if (lPrepared.text) {
						prepared.text = lPrepared.text;
					}
					if (lPrepared.file.attachment) {
						prepared.files.push(lPrepared.file);
					}
				}

				//ctx.TediCross.logger.info(`Files Array Length: ${prepared.files.length}`);

				relayMessage(comboCtx);
			}
		} else {
			//ctx.TediCross.logger.info(`No groupId: ${groupId}`);
			return;
		}
	} else {
		let ctxArray: TediCrossContext[] | undefined;
		ctxArray = groupIdMap.get(groupId);
		if (!ctxArray) ctxArray = [];
		ctxArray.push(ctx);
		groupIdMap.set(groupId, ctxArray);
	}
};

/**
 * Relays a message from Telegram to Discord
 *
 * @param ctx The Telegraf context
 * @param ctx.tediCross	The TediCross context of the message
 * @param ctx.TediCross	The global TediCross context of the message
 */
interface PreparedFile {
    link: string;
    name?: string;
}

// 🔥 ID del tema de Telegram que representa "Noticias"
const NOTICIAS_THREAD_ID = 86; // Cambia esto por el ID real de tu tema de noticias

export const relayMessage = async (ctx: TediCrossContext) => {
    console.log("🔄 relayMessage ejecutado para mensaje en Telegram (Tópico: " + ctx.tediCross.message?.message_thread_id + ")");

    // 📂 **OBTENER ARCHIVOS ADJUNTOS**
    let files: PreparedFile[] = ctx.tediCross.prepared
        .map((prepared: any) => prepared.file as PreparedFile)
        .filter((file: PreparedFile) => file && file.link);

    console.log(`📂 Archivos detectados inicialmente: ${files.length}`);

    // 🚀 **Si no se detectaron archivos, verificar si es una foto de Telegram**
    if (files.length === 0 && ctx.tediCross.message?.photo) {
        const photoArray = ctx.tediCross.message.photo;
        const largestPhoto = photoArray[photoArray.length - 1]; // Obtener la mejor calidad

        if (largestPhoto) {
            const fileId = largestPhoto.file_id;

            try {
                // 🔥 Obtener la URL real del archivo desde Telegram
                const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
                const data = await response.json();

                if (data.ok && data.result.file_path) {
                    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${data.result.file_path}`;
                    files.push({ link: fileUrl, name: "telegram_photo.jpg" });
                    console.log("📸 Se ha obtenido la URL correcta de la imagen de Telegram.");
                } else {
                    console.log("❌ ERROR: No se pudo obtener la URL de la imagen desde Telegram.");
                }

            } catch (error) {
                console.error("❌ ERROR al obtener la imagen desde Telegram:", error);
            }
        }
    }

    console.log(`📂 Total de archivos detectados después de verificar fotos: ${files.length}`);

    // 🚨 **FILTRAR SOLO IMÁGENES DEL TEMA DE NOTICIAS**
    if (files.length > 0 && ctx.tediCross.message?.message_thread_id !== NOTICIAS_THREAD_ID) {
        console.log("⚠️ Imagen recibida en un tema diferente a Noticias. No se enviará a Discord.");
        return;
    }

    // 🚀 **Si no hay imágenes, detener el proceso**
    if (files.length === 0) {
        console.log("⚠️ No hay imágenes en el mensaje, no se enviará a Discord.");
        return;
    }

    try {
        // ✅ Verificar que el bot de Discord está listo
        await ctx.TediCross.dcBot.ready;
        console.log("✅ Discord bot está listo, buscando canal...");

        // ✅ Obtener el canal de Discord correcto
        const channel = ctx.tediCross.discordChannelId 
            ? await ctx.TediCross.dcBot.channels.fetch(ctx.tediCross.discordChannelId) 
            : await fetchDiscordChannel(ctx.TediCross.dcBot, ctx.tediCross.bridges[0], ctx.tediCross.message?.message_thread_id);

        if (!channel) {
            console.error("❌ ERROR: No se pudo obtener el canal de Discord.");
            return;
        }

        console.log("✅ Canal de Discord obtenido: " + channel.id);

        // ✅ **CREAR OBJETO DE ENVÍO**
        const sendOptions: any = {};

        if (files.length > 0) {
            sendOptions.files = files.map(file => ({ attachment: file.link, name: file.name || "archivo.jpg" }));
        }

        // 🚀 **EVITAR DUPLICACIÓN DE IMÁGENES**
        if (!ctx.tediCross.alreadyProcessed) {
            const sentMessage = await channel.send(sendOptions);
            console.log("✅ Imagen enviada a Discord con ID: " + sentMessage.id);

            // 🚀 **MARCAR COMO PROCESADO**
            ctx.tediCross.alreadyProcessed = true;
            console.log("✅ Imagen marcada como procesada para evitar duplicación.");
        } else {
            console.log("⚠️ Imagen ya procesada previamente, evitando duplicación.");
        }

    } catch (err: any) {
        console.error("❌ ERROR al enviar imagen a Discord: " + err.message);
    }
};


/**
 * Handles message edits
 *
 * @param ctx	The Telegraf context
 */
export const handleEdits = createMessageHandler(async (ctx: TediCrossContext, bridge: any) => {
	// Function to "delete" a message on Discord
	const del = async (ctx: TediCrossContext, bridge: any) => {
		try {
			// Wait for the Discord bot to become ready
			await ctx.TediCross.dcBot.ready;

			// Find the ID of this message on Discord
			const [dcMessageId] = await ctx.TediCross.messageMap.getCorresponding(
				MessageMap.TELEGRAM_TO_DISCORD,
				bridge,
				ctx.tediCross.message.message_id
			);
			//console.log("t2d delete getCorresponding: " + dcMessageId);

			// Get the channel to delete on
			//const channel = await fetchDiscordChannel(ctx.TediCross.dcBot, bridge);
			const channel = await ctx.TediCross.dcBot.channels.fetch(ctx.tediCross.discordChannelId);

			// Delete it on Discord
			const dp = channel.bulkDelete([dcMessageId]);

			// Delete it on Telegram
			const tp = ctx.deleteMessage();

			await Promise.all([dp, tp]);
		} catch (err: any) {
			ctx.TediCross.logger.error(
				`Could not cross-delete message from Telegram to Discord on bridge ${bridge.name}: ${err.message}`
			);
		}
	};

	// Function to edit a message on Discord
	const edit = async (ctx: TediCrossContext, bridge: any) => {
		try {
			const tgMessage = ctx.tediCross.message;

			// Wait for the Discord bot to become ready
			await ctx.TediCross.dcBot.ready;

			// Find the ID of this message on Discord
			const [dcMessageId] = await ctx.TediCross.messageMap.getCorresponding(
				MessageMap.TELEGRAM_TO_DISCORD,
				bridge,
				tgMessage.message_id
			);

			// Get the messages from Discord
			const dcMessage = await fetchDiscordChannel(ctx.TediCross.dcBot, bridge, tgMessage.message_thread_id).then(
				channel => channel.messages.fetch(dcMessageId)
			);

			R.forEach(async (prepared: any) => {
				// Discord doesn't handle messages longer than 2000 characters. Take only the first 2000
				const messageText = prepared.header + "\n" + prepared.text; //  R.slice(0, 2000,
				const sendObject: DiscordMessage = {};

				const useEmbeds =
					(messageText.length > 2000 && prepared.bridge.discord.useEmbeds !== "never") || prepared.hasLinks;

				if (useEmbeds) {
					const text =
						prepared.text.length > 4096 ? prepared.text.substring(0, 4090) + "..." : prepared.text || " ";
					const embeds: EmbedBuilder[] = [];
					// build text embed
					const embed = new EmbedBuilder().setDescription(text);
					if (prepared.header) {
						embed.setTitle(prepared.header);
					}
					embeds.push(embed);

					const photoEmbeds: any[] = [];

					if (!R.isNil(prepared.file)) {
						const files = prepared.files || [prepared.file];
						let tempPhotoUrl: string = "";
						for (const file of files) {
							// only photo attachments can be used as embeds
							if (file.description === "photo") {
								tempPhotoUrl = file.attachment;
								photoEmbeds.push(new EmbedBuilder().setImage(tempPhotoUrl));
							}
						}
						// if only 1 photo - set it into Embed
						if (photoEmbeds.length === 1) {
							embeds[0].setImage(tempPhotoUrl);
						}
					}

					sendObject.embeds = embeds;

					// trying to send prepared message
					try {
						if (typeof dcMessage.edit !== "function") {
							ctx.TediCross.logger.error("dcMessage.edit is not a function");
						} else {
							await dcMessage.edit(sendObject);
						}
					} catch (err: any) {
						ctx.TediCross.logger.error(err);
					}
				} else {
					// old text split version when user don't want to use embeds
					sendObject.content = messageText;

					// if (!R.isNil(prepared.file)) {
					// 	sendObject.files = prepared.files || [prepared.file];
					// }

					// Send them in serial, with the attachment first, if there is one
					if (typeof dcMessage.edit !== "function") {
						ctx.TediCross.logger.error("dcMessage.edit is not a function");
					} else {
						await dcMessage.edit(sendObject as MessageEditOptions);
					}
				}
			})(ctx.tediCross.prepared);
		} catch (err: any) {
			// Log it
			ctx.TediCross.logger.error(
				`Could not cross-edit message from Telegram to Discord on bridge ${bridge.name}: ${err.message}`
			);
		}
	};

	// Check if this is a "delete", meaning it has been edited to a single dot
	if (
		bridge.telegram.crossDeleteOnDiscord &&
		ctx.tediCross.text.raw === "." &&
		R.isEmpty(ctx.tediCross.text.entities)
	) {
		await del(ctx, bridge);
	} else {
		await edit(ctx, bridge);
	}
});
