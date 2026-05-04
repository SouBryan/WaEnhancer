import { appendFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ARRAYS_XML_PATH = path.resolve(process.cwd(), "app/src/main/res/values/arrays.xml");

function getArgValue(flagName) {
    const index = process.argv.indexOf(flagName);
    if (index === -1 || index + 1 >= process.argv.length) {
        return null;
    }
    return process.argv[index + 1];
}

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

function getArrayBlock(xml, arrayName) {
    const regex = new RegExp(`<string-array name="${arrayName}">([\\s\\S]*?)</string-array>`);
    const match = xml.match(regex);
    if (!match) {
        throw new Error(`Array ${arrayName} not found in arrays.xml`);
    }
    return Array.from(match[1].matchAll(/<item>([^<]+)<\/item>/g), itemMatch => itemMatch[1]).sort(comparePatternsAscending);
}

function setGithubOutput(name, value) {
    if (!process.env.GITHUB_OUTPUT) {
        return;
    }
    const escapedValue = String(value ?? "").replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${escapedValue}\n`);
}

async function main() {
    const outputPath = getArgValue("--output") ?? process.env.RELEASE_NOTES_PATH;
    const arraysXml = await fs.readFile(ARRAYS_XML_PATH, "utf8");
    const messengerPatterns = getArrayBlock(arraysXml, "supported_versions_wpp");
    const businessPatterns = getArrayBlock(arraysXml, "supported_versions_business");
    const latestMessengerPattern = messengerPatterns.at(-1) ?? "unknown";
    const latestBusinessPattern = businessPatterns.at(-1) ?? "unknown";

    setGithubOutput("messenger_patterns", messengerPatterns.join(", "));
    setGithubOutput("business_patterns", businessPatterns.join(", "));
    setGithubOutput("messenger_latest_pattern", latestMessengerPattern);
    setGithubOutput("business_latest_pattern", latestBusinessPattern);

    const lines = [
        "Signed release build.",
        "",
        `Latest supported WhatsApp pattern: ${latestMessengerPattern}`,
        `Latest supported WhatsApp Business pattern: ${latestBusinessPattern}`,
        "",
        `Current supported patterns (WhatsApp): ${messengerPatterns.join(", ")}`,
        `Current supported patterns (WhatsApp Business): ${businessPatterns.join(", ")}`
    ];

    if (process.env.UPSTREAM_SHA) {
        lines.push("", `Upstream commit: https://github.com/Dev4Mod/WaEnhancer/commit/${process.env.UPSTREAM_SHA}`);
    }

    if (process.env.MESSENGER_STABLE || process.env.MESSENGER_BETA || process.env.BUSINESS_STABLE || process.env.BUSINESS_BETA) {
        lines.push("", "Detected APKMirror versions:");
        if (process.env.MESSENGER_STABLE) {
            lines.push(`WhatsApp Messenger stable: ${process.env.MESSENGER_STABLE}`);
        }
        if (process.env.MESSENGER_BETA) {
            lines.push(`WhatsApp Messenger beta: ${process.env.MESSENGER_BETA}`);
        }
        if (process.env.BUSINESS_STABLE) {
            lines.push(`WhatsApp Business stable: ${process.env.BUSINESS_STABLE}`);
        }
        if (process.env.BUSINESS_BETA) {
            lines.push(`WhatsApp Business beta: ${process.env.BUSINESS_BETA}`);
        }
    }

    const body = `${lines.join("\n")}\n`;
    if (outputPath) {
        await fs.writeFile(outputPath, body, "utf8");
    }
    process.stdout.write(body);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});