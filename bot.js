import dotenv from "dotenv";
import { existsSync } from "fs";
import { Telegraf, Input } from "telegraf";
import { askAI, askGeminiFromImageBuffer } from "./ai.js";

dotenv.config();

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN не найден в .env");
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const SPECIAL_USERNAME = "nn_userrr";
const SPECIAL_VIDEO = "./sticker.webm";

let botUsername = "";
let botId = null;

const privateModes = new Map();

function getPrivateMode(chatId) {
  return privateModes.get(chatId) ?? "fast";
}

function setPrivateMode(chatId, mode) {
  privateModes.set(chatId, mode);
}

function isSpecialUser(ctx) {
  const username = ctx.from?.username;
  return (
    typeof username === "string" &&
    username.toLowerCase() === SPECIAL_USERNAME.toLowerCase()
  );
}

async function sendSpecialVideo(ctx) {
  if (!existsSync(SPECIAL_VIDEO)) {
    await ctx.reply(`Файл не найден: ${SPECIAL_VIDEO}`);
    return;
  }

  await ctx.replyWithSticker(Input.fromLocalFile(SPECIAL_VIDEO));
}

function removeBotMention(text = "") {
  if (!botUsername) return text;
  const pattern = new RegExp(`@${botUsername}\\b`, "gi");
  return text.replace(pattern, "").trim();
}

function normalizeText(text = "") {
  return removeBotMention(text).trim();
}

function isReplyToBot(message) {
  return message.reply_to_message?.from?.id === botId;
}

function isMentionToBot(message) {
  const text = message.text || message.caption || "";
  if (!text || !botUsername) return false;
  return text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
}

function hasImage(message) {
  if (!message) return false;

  if (message.photo?.length) return true;

  if (
    message.document &&
    typeof message.document.mime_type === "string" &&
    message.document.mime_type.startsWith("image/")
  ) {
    return true;
  }

  return false;
}

function hasVideo(message) {
  if (!message) return false;

  if (message.video) return true;

  if (
    message.document &&
    typeof message.document.mime_type === "string" &&
    message.document.mime_type.startsWith("video/")
  ) {
    return true;
  }

  return false;
}

function hasMedia(message) {
  return hasImage(message) || hasVideo(message);
}

function getMediaFileInfo(message) {
  if (!message) return null;

  if (message.photo?.length) {
    const biggest = message.photo[message.photo.length - 1];
    return {
      fileId: biggest.file_id,
      mimeType: "image/jpeg",
    };
  }

  if (message.video) {
    return {
      fileId: message.video.file_id,
      mimeType: message.video.mime_type || "video/mp4",
    };
  }

  if (
    message.document &&
    typeof message.document.mime_type === "string" &&
    (
      message.document.mime_type.startsWith("image/") ||
      message.document.mime_type.startsWith("video/")
    )
  ) {
    return {
      fileId: message.document.file_id,
      mimeType: message.document.mime_type,
    };
  }

  return null;
}

async function downloadTelegramFileBuffer(ctx, fileId) {
  const fileLink = await ctx.telegram.getFileLink(fileId);
  const response = await fetch(fileLink.href);

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function startsWithSearch(text = "") {
  return /^поиск\s+/i.test(text.trim());
}

function removeSearchPrefix(text = "") {
  return text.replace(/^поиск\s+/i, "").trim();
}

function startsWithMagaSearch(text = "") {
  return /^мага\s+поиск\s+/i.test(text.trim());
}

function removeMagaSearchPrefix(text = "") {
  return text.replace(/^мага\s+поиск\s+/i, "").trim();
}

function startsWithMaga(text = "") {
  return /^мага\b/i.test(text.trim());
}

function removeMagaPrefix(text = "") {
  return text.replace(/^мага\b[\s,.:!?\-]*/i, "").trim();
}

function isOnlyMaga(text = "") {
  return /^мага[\s.!?,-]*$/i.test(text.trim());
}

function extractCommandPrompt(text = "", commandNames = []) {
  const escaped = commandNames.map((cmd) =>
    cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );

  const re = new RegExp(
    `^\\/(?:${escaped.join("|")})(?:@\\w+)?(?:\\s+([\\s\\S]+))?$`,
    "i"
  );

  const match = text.trim().match(re);

  return match ? (match[1] || "").trim() : null;
}

async function processMediaWithGemini(ctx, sourceMessage, promptText) {
  const mediaInfo = getMediaFileInfo(sourceMessage);

  if (!mediaInfo) return;

  const buffer = await downloadTelegramFileBuffer(ctx, mediaInfo.fileId);

  const answer = await askGeminiFromImageBuffer(
    buffer,
    mediaInfo.mimeType,
    promptText || "Опиши содержимое"
  );

  await ctx.reply(answer);
}

async function handlePrivateMessage(ctx) {
  const message = ctx.message;
  const chatId = ctx.chat.id;

  const rawText = message.text || message.caption || "";
  const text = normalizeText(rawText);

  if (!text && !hasMedia(message)) return;

  const brainPrompt = extractCommandPrompt(text, ["brain"]);
  if (brainPrompt !== null) {
    setPrivateMode(chatId, "brain");

    if (!brainPrompt) {
      await ctx.reply("Режим brain включен");
      return;
    }

    const answer = await askAI(1, brainPrompt);
    await ctx.reply(answer);
    return;
  }

  const fastPrompt = extractCommandPrompt(text, ["fast", "faster"]);
  if (fastPrompt !== null) {
    setPrivateMode(chatId, "fast");

    if (!fastPrompt) {
      await ctx.reply("Режим fast включен");
      return;
    }

    const answer = await askAI(2, fastPrompt);
    await ctx.reply(answer);
    return;
  }

  if (startsWithSearch(text)) {
    const query = removeSearchPrefix(text);
    if (!query) return;

    const answer = await askAI(3, query);
    await ctx.reply(answer);
    return;
  }

  if (hasMedia(message)) {
    await processMediaWithGemini(ctx, message, text);
    return;
  }

  const currentMode = getPrivateMode(chatId);

  const answer = await askAI(currentMode === "brain" ? 1 : 2, text);
  await ctx.reply(answer);
}

async function handleGroupMessage(ctx) {
  const message = ctx.message;

  const rawText = message.text || message.caption || "";
  const text = normalizeText(rawText);

  const media = hasMedia(message);

  if (media && startsWithMaga(text)) {
    const prompt = removeMagaPrefix(text);
    await processMediaWithGemini(ctx, message, prompt);
    return;
  }

  if (
    startsWithMaga(text) &&
    message.reply_to_message &&
    hasMedia(message.reply_to_message)
  ) {
    const prompt = removeMagaPrefix(text);
    await processMediaWithGemini(ctx, message.reply_to_message, prompt);
    return;
  }

  if (startsWithMagaSearch(text)) {
    const query = removeMagaSearchPrefix(text);
    if (!query) return;

    const answer = await askAI(3, query);
    await ctx.reply(answer);
    return;
  }

  if (isOnlyMaga(text)) {
    await ctx.reply("Привет");
    return;
  }

  if (startsWithMaga(text)) {
    const prompt = removeMagaPrefix(text);
    if (!prompt) return;

    const answer = await askAI(2, prompt);
    await ctx.reply(answer);
    return;
  }

  const brainPrompt = extractCommandPrompt(text, ["brain"]);
  if (brainPrompt !== null) {
    if (!brainPrompt) {
      await ctx.reply("Напиши: /brain твой запрос");
      return;
    }

    const answer = await askAI(1, brainPrompt);
    await ctx.reply(answer);
    return;
  }

  const fastPrompt = extractCommandPrompt(text, ["fast", "faster"]);
  if (fastPrompt !== null) {
    if (!fastPrompt) {
      await ctx.reply("Напиши: /fast твой запрос");
      return;
    }

    const answer = await askAI(2, fastPrompt);
    await ctx.reply(answer);
    return;
  }

  if (isReplyToBot(message) || isMentionToBot(message)) {
    if (media) {
      await processMediaWithGemini(ctx, message, text);
      return;
    }

    if (!text) return;

    const answer = await askAI(2, text);
    await ctx.reply(answer);
  }
}

async function handleUserMessage(ctx) {
  if (!ctx.message) return;

  try {
    if (isSpecialUser(ctx)) {
      await sendSpecialVideo(ctx);
      return;
    }

    if (ctx.chat?.type === "private") {
      await handlePrivateMessage(ctx);
    } else {
      await handleGroupMessage(ctx);
    }
  } catch (error) {
    console.error(error);
  }
}

bot.start(async (ctx) => {
  await ctx.reply(
    "Привет. Команды: /brain, /fast\n\n" +
    "В личке можно просто писать сообщения.\n" +
    "Для поиска: поиск твой запрос\n" +
    "В группе: мага твой запрос"
  );
});

bot.on("text", handleUserMessage);
bot.on("photo", handleUserMessage);
bot.on("video", handleUserMessage);
bot.on("document", handleUserMessage);

bot.catch((err) => {
  console.error("Telegram bot error:", err);
});

async function start() {
  const me = await bot.telegram.getMe();
  botUsername = me.username || "";
  botId = me.id;

  await bot.telegram.setMyCommands([
    { command: "start", description: "Запустить бота" },
    { command: "brain", description: "Умный режим" },
    { command: "fast", description: "Быстрый режим" },
    { command: "faster", description: "Быстрый режим" },
  ]);

  await bot.launch();

  console.log(`Bot started as @${botUsername}`);
}

start();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));