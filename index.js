const { Client, GatewayIntentBits, SlashCommandBuilder } = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) throw new Error("Set the DISCORD_TOKEN environment variable.");

// Undocumented endpoint used by Discord's signup page. May change or rate-limit.
const CHECK_URL = "https://discord.com/api/v9/unique-username/username-attempt-unauthed";

const CHARSETS = {
  letters: "abcdefghijklmnopqrstuvwxyz",
  "letters+digits": "abcdefghijklmnopqrstuvwxyz0123456789",
  "letters+underscore+dot": "abcdefghijklmnopqrstuvwxyz_.",
};

const REQUEST_DELAY = 1500; // ms between checks
const MAX_CHECKS = 60; // hard cap per command

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function valid(name) {
  return !/^[._]|[._]$/.test(name) && !name.includes("..");
}

function* candidates(chars, mode) {
  if (mode === "random") {
    const seen = new Set();
    while (true) {
      let name = "";
      for (let i = 0; i < 4; i++) name += chars[Math.floor(Math.random() * chars.length)];
      if (valid(name) && !seen.has(name)) {
        seen.add(name);
        yield name;
      }
    }
  } else {
    const n = chars.length;
    for (let i = 0; i < n ** 4; i++) {
      let x = i;
      let name = "";
      for (let j = 0; j < 4; j++) {
        name = chars[x % n] + name;
        x = Math.floor(x / n);
      }
      if (valid(name)) yield name;
    }
  }
}

// true = available, false = taken, null = unknown
async function isAvailable(name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(CHECK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: name }),
      });
      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        await sleep(((data.retry_after ?? 5) + 0.5) * 1000);
        continue;
      }
      if (!res.ok) return null;
      const data = await res.json();
      return !data.taken;
    } catch {
      await sleep(2000);
    }
  }
  return null;
}

const command = new SlashCommandBuilder()
  .setName("find4")
  .setDescription("Search for available 4-character Discord usernames")
  .addIntegerOption((o) =>
    o.setName("amount").setDescription("How many to find (1-10)").setMinValue(1).setMaxValue(10)
  )
  .addStringOption((o) =>
    o
      .setName("charset")
      .setDescription("Which characters to use")
      .addChoices(...Object.keys(CHARSETS).map((k) => ({ name: k, value: k })))
  )
  .addStringOption((o) =>
    o
      .setName("mode")
      .setDescription("Random picks or alphabetical order")
      .addChoices({ name: "random", value: "random" }, { name: "alphabetical", value: "alpha" })
  );

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let busy = false;

client.once("ready", async () => {
  await client.application.commands.set([command.toJSON()]);
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "find4") return;

  if (busy) {
    return interaction.reply({ content: "A search is already running, try again shortly.", ephemeral: true });
  }

  const amount = interaction.options.getInteger("amount") ?? 3;
  const charset = interaction.options.getString("charset") ?? "letters";
  const mode = interaction.options.getString("mode") ?? "random";

  await interaction.deferReply();
  busy = true;
  const found = [];
  let checked = 0;

  try {
    for (const name of candidates(CHARSETS[charset], mode)) {
      if (found.length >= amount || checked >= MAX_CHECKS) break;
      const result = await isAvailable(name);
      checked++;
      if (result) found.push(name);
      await sleep(REQUEST_DELAY);
    }
  } finally {
    busy = false;
  }

  const msg = found.length
    ? `Available 4-character usernames (${checked} checked):\n${found.map((n) => `\`${n}\``).join("\n")}`
    : `None found after checking ${checked} names. Try again or change the character set.`;
  await interaction.editReply(msg);
});

client.login(TOKEN);
