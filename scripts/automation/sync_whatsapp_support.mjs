import { appendFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { chromium } from "playwright";

const APKMIRROR_SEARCH_URL = "https://www.apkmirror.com/?post_type=app_release&searchtype=apk&s=whatsapp";
const ARRAYS_XML_PATH = path.resolve(process.cwd(), "app/src/main/res/values/arrays.xml");
const APPS = {
    messenger: {
        label: "WhatsApp Messenger",
        arrayName: "supported_versions_wpp"
    },
    business: {
        label: "WhatsApp Business",
        arrayName: "supported_versions_business"
    }
};

function semverTuple(pattern) {
    return pattern
        .replace(/\.xx$/, "")
        .split(".")
        .slice(0, 3)
        .map(part => Number.parseInt(part, 10));
}

function comparePatternsAscending(left, right) {
    const leftTuple = semverTuple(left);
    const rightTuple = semverTuple(right);
    for (let index = 0; index < 3; index += 1) {
        if (leftTuple[index] !== rightTuple[index]) {
            return leftTuple[index] - rightTuple[index];
        }
    }
    return left.localeCompare(right);
}

function toSupportPattern(version) {
    const parts = version.split(".");
    if (parts.length < 3 || parts.slice(0, 3).some(part => !/^\d+$/.test(part))) {
        throw new Error(`Unsupported WhatsApp version format: ${version}`);
    }
    return `${parts[0]}.${parts[1]}.${parts[2]}.xx`;
}

function dedupeAndSort(values) {
    return Array.from(new Set(values)).sort(comparePatternsAscending);
}

function extractVersions(bodyText) {
    const versions = {
        messenger: {
            stableRaw: null,
            betaRaw: null
        },
        business: {
            stableRaw: null,
            betaRaw: null
        }
    };

    const entryRegex = /(WhatsApp Messenger|WhatsApp Business)\s+(\d+(?:\.\d+){2,})(\s+beta)?\s+by WhatsApp LLC/gi;
    for (const match of bodyText.matchAll(entryRegex)) {
        const key = match[1] === APPS.messenger.label ? "messenger" : "business";
        const version = match[2];
        const slot = match[3] ? "betaRaw" : "stableRaw";
        if (!versions[key][slot]) {
            versions[key][slot] = version;
        }
        if (Object.values(versions.messenger).every(Boolean) && Object.values(versions.business).every(Boolean)) {
            break;
        }
    }

    for (const [key, value] of Object.entries(versions)) {
        if (!value.stableRaw || !value.betaRaw) {
            throw new Error(`Could not find stable and beta versions for ${key} on APKMirror search results.`);
        }
        value.stablePattern = toSupportPattern(value.stableRaw);
        value.betaPattern = toSupportPattern(value.betaRaw);
    }

    return versions;
}

async function scrapeApkMirror() {
    const browser = await chromium.launch({
        headless: true,
        args: ["--disable-blink-features=AutomationControlled"]
    });
    const page = await browser.newPage({
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    });

    try {
        await page.goto(APKMIRROR_SEARCH_URL, {
            waitUntil: "domcontentloaded",
            timeout: 120_000
        });
        await page.waitForFunction(() => {
            const text = document.body?.innerText ?? "";
            return /Results for/i.test(text) && !/Just a moment|Executando verificação de segurança|Enable JavaScript and cookies to continue/i.test(text);
        }, {
            timeout: 120_000
        });

        const bodyText = await page.locator("body").innerText();
        return extractVersions(bodyText);
    } finally {
        await page.close();
        await browser.close();
    }
}

function getArrayBlock(xml, arrayName) {
    const regex = new RegExp(`<string-array name="${arrayName}">([\\s\\S]*?)</string-array>`);
    const match = xml.match(regex);
    if (!match) {
        throw new Error(`Array ${arrayName} not found in arrays.xml`);
    }
    const items = Array.from(match[1].matchAll(/<item>([^<]+)<\/item>/g), itemMatch => itemMatch[1]);
    return {
        raw: match[0],
        items
    };
}

function replaceArrayBlock(xml, arrayName, values) {
    const regex = new RegExp(`<string-array name="${arrayName}">([\\s\\S]*?)</string-array>`);
    const items = values.map(value => `        <item>${value}</item>`).join("\n");
    return xml.replace(regex, `<string-array name="${arrayName}">\n${items}\n    </string-array>`);
}

function setGithubOutput(name, value) {
    if (!process.env.GITHUB_OUTPUT) {
        return;
    }
    const escapedValue = String(value ?? "").replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${escapedValue}\n`);
}

async function main() {
    const discoveredVersions = await scrapeApkMirror();
    const arraysXml = await fs.readFile(ARRAYS_XML_PATH, "utf8");

    const messengerBlock = getArrayBlock(arraysXml, APPS.messenger.arrayName);
    const businessBlock = getArrayBlock(arraysXml, APPS.business.arrayName);

    const nextMessengerValues = dedupeAndSort([
        ...messengerBlock.items,
        discoveredVersions.messenger.stablePattern,
        discoveredVersions.messenger.betaPattern
    ]);
    const nextBusinessValues = dedupeAndSort([
        ...businessBlock.items,
        discoveredVersions.business.stablePattern,
        discoveredVersions.business.betaPattern
    ]);

    const messengerAdded = nextMessengerValues.filter(value => !messengerBlock.items.includes(value));
    const businessAdded = nextBusinessValues.filter(value => !businessBlock.items.includes(value));

    let nextXml = arraysXml;
    nextXml = replaceArrayBlock(nextXml, APPS.messenger.arrayName, nextMessengerValues);
    nextXml = replaceArrayBlock(nextXml, APPS.business.arrayName, nextBusinessValues);

    if (nextXml !== arraysXml) {
        await fs.writeFile(ARRAYS_XML_PATH, nextXml, "utf8");
    }

    setGithubOutput("messenger_stable", discoveredVersions.messenger.stableRaw);
    setGithubOutput("messenger_beta", discoveredVersions.messenger.betaRaw);
    setGithubOutput("business_stable", discoveredVersions.business.stableRaw);
    setGithubOutput("business_beta", discoveredVersions.business.betaRaw);
    setGithubOutput("messenger_patterns", nextMessengerValues.join(", "));
    setGithubOutput("business_patterns", nextBusinessValues.join(", "));
    setGithubOutput("messenger_added", messengerAdded.join(", "));
    setGithubOutput("business_added", businessAdded.join(", "));

    const summary = {
        messenger: discoveredVersions.messenger,
        business: discoveredVersions.business,
        messengerAdded,
        businessAdded,
        updatedArraysXml: nextXml !== arraysXml
    };
    console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});