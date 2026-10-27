import asyncio
import itertools
import os
import random
import string

import aiohttp
import discord
from discord import app_commands

TOKEN = os.environ["DISCORD_TOKEN"]

# Discord's username-availability endpoint (the one the signup page uses).
# It is undocumented, so it may change or rate-limit you at any time.
CHECK_URL = "https://discord.com/api/v9/unique-username/username-attempt-unauthed"

CHARSETS = {
    "letters": string.ascii_lowercase,
    "letters+digits": string.ascii_lowercase + string.digits,
    "letters+underscore+dot": string.ascii_lowercase + "_.",
}

# Be gentle: one request at a time with a delay between them.
REQUEST_DELAY = 1.5
MAX_CHECKS = 60  # hard cap per command so a single call can't run forever


class Bot(discord.Client):
    def __init__(self):
        super().__init__(intents=discord.Intents.default())
        self.tree = app_commands.CommandTree(self)
        self.session: aiohttp.ClientSession | None = None
        self.lock = asyncio.Lock()  # only one search at a time, globally

    async def setup_hook(self):
        self.session = aiohttp.ClientSession()
        await self.tree.sync()

    async def close(self):
        if self.session:
            await self.session.close()
        await super().close()


bot = Bot()


async def is_available(session: aiohttp.ClientSession, name: str) -> bool | None:
    """True = available, False = taken, None = couldn't tell."""
    for _ in range(3):
        try:
            async with session.post(CHECK_URL, json={"username": name}) as r:
                if r.status == 429:
                    data = await r.json(content_type=None)
                    await asyncio.sleep(float(data.get("retry_after", 5)) + 0.5)
                    continue
                if r.status != 200:
                    return None
                data = await r.json(content_type=None)
                return not data.get("taken", True)
        except aiohttp.ClientError:
            await asyncio.sleep(2)
    return None


def candidates(charset: str, mode: str):
    chars = CHARSETS[charset]
    if mode == "random":
        seen = set()
        while True:
            name = "".join(random.choices(chars, k=4))
            if name[0] in "._" or name[-1] in "._" or ".." in name:
                continue
            if name not in seen:
                seen.add(name)
                yield name
    else:  # sequential / alphabetical
        for combo in itertools.product(chars, repeat=4):
            name = "".join(combo)
            if name[0] in "._" or name[-1] in "._" or ".." in name:
                continue
            yield name


@bot.tree.command(name="find4", description="Search for available 4-character Discord usernames")
@app_commands.describe(
    amount="How many available usernames to find (1-10)",
    charset="Which characters to use",
    mode="Random picks or alphabetical order",
)
@app_commands.choices(
    charset=[app_commands.Choice(name=k, value=k) for k in CHARSETS],
    mode=[
        app_commands.Choice(name="random", value="random"),
        app_commands.Choice(name="alphabetical", value="alpha"),
    ],
)
async def find4(
    interaction: discord.Interaction,
    amount: app_commands.Range[int, 1, 10] = 3,
    charset: app_commands.Choice[str] | None = None,
    mode: app_commands.Choice[str] | None = None,
):
    if bot.lock.locked():
        await interaction.response.send_message("A search is already running, try again shortly.", ephemeral=True)
        return

    await interaction.response.defer(thinking=True)
    charset_key = charset.value if charset else "letters"
    mode_key = mode.value if mode else "random"

    found, checked = [], 0
    async with bot.lock:
        for name in candidates(charset_key, mode_key):
            if len(found) >= amount or checked >= MAX_CHECKS:
                break
            result = await is_available(bot.session, name)
            checked += 1
            if result:
                found.append(name)
            await asyncio.sleep(REQUEST_DELAY)

    if found:
        lines = "\n".join(f"`{n}`" for n in found)
        msg = f"Available 4-character usernames ({checked} checked):\n{lines}"
    else:
        msg = f"None found after checking {checked} names. Try again or change the character set."
    await interaction.followup.send(msg)


bot.run(TOKEN)
