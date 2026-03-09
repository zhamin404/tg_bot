import OpenAI from "openai";
import dotenv from "dotenv";
import { tavily } from "@tavily/core";
import {
  GoogleGenAI,
  createPartFromUri,
  createUserContent,
} from "@google/genai";
import fs from "fs/promises";
import path from "path";
import os from "os";

dotenv.config();

if (!process.env.GROQ_API_KEY) {
  throw new Error("GROQ_API_KEY не найден в .env");
}

if (!process.env.TAVILY_API_KEY) {
  throw new Error("TAVILY_API_KEY не найден в .env");
}

if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY не найден в .env");
}

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const tavilyClient = tavily({
  apiKey: process.env.TAVILY_API_KEY,
});

export function getModelByType(type) {
  if (type === 1) return "llama-3.3-70b-versatile"; // умный
  if (type === 2) return "llama-3.1-8b-instant"; // быстрый
  return "llama-3.3-70b-versatile"; // для поиска
}

export async function askGroq(model, prompt) {
  try {
    const response = await groq.responses.create({
      model,
      input: prompt,
    });

    return response.output_text || "Groq не вернул ответ";
  } catch (error) {
    if (error?.status === 429) {
      return "Лимит Groq закончился";
    }

    if (error?.status === 401) {
      return "Неверный GROQ_API_KEY";
    }

    if (error?.status === 404) {
      return `Модель ${model} не найдена или нет доступа`;
    }

    console.error("Groq error:", error);
    return "Ошибка Groq";
  }
}

async function searchWithTavilyFetch(query) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      search_depth: "advanced",
      max_results: 5,
    }),
  });

  const contentType = response.headers.get("content-type") || "";
  const rawText = await response.text();

  if (response.status === 429) {
    throw new Error("Лимит Tavily закончился");
  }

  if (response.status === 401) {
    throw new Error("Неверный TAVILY_API_KEY");
  }

  if (response.status === 403) {
    console.error("Tavily fetch 403:", rawText);
    throw new Error("Tavily отклонил запрос (403 Forbidden)");
  }

  if (!response.ok) {
    console.error("Tavily fetch HTTP error:", response.status, rawText);
    throw new Error(`Ошибка Tavily HTTP ${response.status}`);
  }

  if (!contentType.includes("application/json")) {
    console.error("Tavily fetch non-JSON:", rawText);
    throw new Error("Tavily вернул не JSON");
  }

  const data = JSON.parse(rawText);
  return data?.results || [];
}

export async function searchWithTavily(query) {
  try {
    const response = await tavilyClient.search(query, {
      searchDepth: "advanced",
      maxResults: 5,
    });

    return response?.results || [];
  } catch (error) {
    const status = error?.status;
    const message = String(error?.message || "").toLowerCase();

    console.error("Tavily SDK error:", {
      status: error?.status,
      message: error?.message,
      name: error?.name,
    });

    if (status === 429 || message.includes("429")) {
      throw new Error("Лимит Tavily закончился");
    }

    if (
      status === 401 ||
      message.includes("401") ||
      message.includes("unauthorized")
    ) {
      throw new Error("Неверный TAVILY_API_KEY");
    }

    if (status === 403 || message.includes("403 forbidden")) {
      return await searchWithTavilyFetch(query);
    }

    throw new Error("Ошибка Tavily");
  }
}

export async function askAI(type, prompt) {
  const model = getModelByType(type);

  if (type === 3) {
    try {
      const results = await searchWithTavily(prompt);

      if (!results.length) {
        return "Ничего не найдено в интернете";
      }

      const context = results
        .map((r, i) =>
          [
            `Источник ${i + 1}: ${r.title || "Без названия"}`,
            `URL: ${r.url || "Нет URL"}`,
            `Текст: ${r.content || "Нет текста"}`,
          ].join("\n")
        )
        .join("\n\n");

      const finalPrompt = `
Ответь на основе найденной информации из интернета.
Если данных мало, так и скажи.
Не выдумывай факты.

Вопрос:
${prompt}

Найденная информация:
${context}
`;

      return await askGroq(model, finalPrompt);
    } catch (error) {
      if (error.message === "Лимит Tavily закончился") {
        return "Лимит Tavily закончился";
      }

      if (error.message === "Неверный TAVILY_API_KEY") {
        return "Неверный TAVILY_API_KEY";
      }

      if (error.message === "Tavily отклонил запрос (403 Forbidden)") {
        return "Tavily отклонил запрос (403 Forbidden). Проверь API-ключ, VPN, proxy или ограничения сети.";
      }

      if (String(error.message || "").startsWith("Ошибка Tavily HTTP")) {
        return error.message;
      }

      if (error.message === "Tavily вернул не JSON") {
        return "Tavily вернул не JSON, а другой ответ сервера";
      }

      return "Ошибка поиска";
    }
  }

  return await askGroq(model, prompt);
}

function getExtensionByMimeType(mimeType = "") {
  const normalized = mimeType.toLowerCase();

  if (normalized === "image/png") return "png";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";

  if (normalized === "video/mp4") return "mp4";
  if (normalized === "video/quicktime") return "mov";
  if (normalized === "video/webm") return "webm";
  if (normalized === "video/x-matroska") return "mkv";
  if (normalized === "video/3gpp") return "3gp";

  return "bin";
}

function getDefaultPromptByMimeType(mimeType = "") {
  const normalized = mimeType.toLowerCase();

  if (normalized.startsWith("video/")) {
    return "Опиши подробно, что происходит на этом видео";
  }

  return "Опиши это изображение";
}

export async function askGeminiFromMediaBuffer(
  buffer,
  mimeType,
  prompt
) {
  let tempFilePath = null;

  try {
    const ext = getExtensionByMimeType(mimeType);
    const prefix = mimeType?.startsWith("video/") ? "tg_video_" : "tg_media_";

    tempFilePath = path.join(os.tmpdir(), `${prefix}${Date.now()}.${ext}`);

    await fs.writeFile(tempFilePath, buffer);

    const uploadedFile = await gemini.files.upload({
      file: tempFilePath,
      config: { mimeType },
    });

    const finalPrompt = prompt?.trim() || getDefaultPromptByMimeType(mimeType);

    const response = await gemini.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        createUserContent([
          finalPrompt,
          createPartFromUri(uploadedFile.uri, uploadedFile.mimeType),
        ]),
      ],
    });

    return response.text || "Gemini не вернул ответ";
  } catch (error) {
    console.error("Gemini error:", error);

    if (String(error?.message || "").includes("API key")) {
      return "Неверный GEMINI_API_KEY";
    }

    return "Ошибка Gemini";
  } finally {
    if (tempFilePath) {
      try {
        await fs.unlink(tempFilePath);
      } catch {
        // ignore
      }
    }
  }
}

export async function askGeminiFromImageBuffer(
  buffer,
  mimeType,
  prompt = "Опиши это изображение"
) {
  return askGeminiFromMediaBuffer(buffer, mimeType, prompt);
}