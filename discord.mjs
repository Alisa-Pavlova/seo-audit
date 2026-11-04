import fs from "node:fs/promises";

// Отправляет сводку и картинку в Discord новым сообщением — старые остаются историей

// Локально хук берется из .env; в GitHub Actions файла нет — там переменная из секретов
try {
  process.loadEnvFile();
} catch {
  // .env нет — используем окружение как есть
}

const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
if (!webhookUrl) {
  console.error("DISCORD_WEBHOOK_URL не задан");
  process.exit(1);
}

const reportUrl =
  process.env.REPORT_URL || "https://alisa-pavlova.github.io/seo-audit/";

// Ссылка спрятана в текст; <> отключает превью, чтобы оно не перебивало картинку
const content =
  (await fs.readFile("docs/discord.txt", "utf8")) +
  `🔗 [Подробный отчет](<${reportUrl}>)\n`;

const form = new FormData();
form.append(
  "payload_json",
  JSON.stringify({ content, allowed_mentions: { parse: [] } }),
);
form.append(
  "files[0]",
  new Blob([await fs.readFile("docs/trends.png")], { type: "image/png" }),
  "lighthouse.png",
);

const response = await fetch(webhookUrl, { method: "POST", body: form });
if (!response.ok) {
  console.error(`Discord ответил ${response.status}: ${await response.text()}`);
  process.exit(1);
}

console.log("discord ok");
