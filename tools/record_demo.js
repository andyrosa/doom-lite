// Records the runbabyrun demo and stores it in index.html.
//
// Usage: node tools/record_demo.js [--edge=PATH_TO_MSEDGE]
//
// Step 1 builds a recording page: a copy of index.html in which the demo asks the bot in demo_bot.js for each tic's
// input. Headless Microsoft Edge runs the page, and the page prints the bot's input.
// Step 2 checks that the bot finished the level, killed every monster, and collected every item.
// Step 3 writes the input into the DEMO_INPUT constant of index.html.
// Step 4 builds a playback page from the updated index.html, with no bot, and checks that the stored demo ends the same way.
//
// The Edge path comes from --edge, then from the environment variable DOOM_LITE_EDGE, then from DEFAULT_EDGE_PATH.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const DEFAULT_EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EDGE_ENVIRONMENT_VARIABLE = 'DOOM_LITE_EDGE';
const EDGE_TIMEOUT_MILLISECONDS = 120000;
const CHEAT_CODE = 'runbabyrun';
const MAX_FRAMES = 6000;
const FRAMES_AFTER_DEMO = 5;
const INPUT_LINE_LENGTH = 150;
const RESULT_START = 'DEMO-RESULT-START';
const RESULT_END = 'DEMO-RESULT-END';

const repositoryPath = path.resolve(__dirname, '..');
const indexPath = path.join(repositoryPath, 'index.html');
const botPath = path.join(__dirname, 'demo_bot.js');

function edgePath() {
    const argument = process.argv.slice(2).find((value) => value.startsWith('--edge='));
    if (argument !== undefined) { return argument.slice('--edge='.length); }
    if (process.env[EDGE_ENVIRONMENT_VARIABLE]) { return process.env[EDGE_ENVIRONMENT_VARIABLE]; }
    return DEFAULT_EDGE_PATH;
}

function replaceOnce(text, oldText, newText, description) {
    if (text.split(oldText).length !== 2) {
        throw new Error('Expected exactly one occurrence of ' + description + ' in index.html: ' + oldText);
    }
    return text.replace(oldText, () => newText);
}

// Returns a page made from the game page. The page runs the game frame by frame without waiting for the display,
// types the cheat code, runs until the demo ends, and prints a summary and the bot's recorded input.
function buildTestPage(gamePage, useBot) {
    let page = gamePage;
    if (useBot) {
        page = replaceOnce(page, "const DEMO_INPUT = '", "const DEMO_INPUT = '0*" + (MAX_FRAMES * 4) + ",", 'the DEMO_INPUT constant');
        page = replaceOnce(page, 'return demoMasks[tic - 1];',
            'return window.testBot({ player: player, things: things, doorSectors: doorSectors, levelTic: tic, exitTics: exitTics, canSee: canSee, weaponReady: weapon.step === WEAPON_READY });',
            'the body of demoMaskAt');
    }
    page = replaceOnce(page, '    buildPalette();\n'.replace('\n', page.includes('\r\n') ? '\r\n' : '\n'),
        `    window.testSummary = () => ({ demoOver: mode !== 'title' && demoMasks === null, finished: mode === 'finished', kills: killCount, monsters: monsterCount,
        itemsLeft: things.filter((thing) => thing.type === 'item').length, health: player === null ? null : player.health,
        armor: player === null ? null : player.armor, ammo: player === null ? null : player.ammo, tics: levelTic });
    buildPalette();
`, 'the buildPalette call');
    const prelude = `<script>
window.testPendingFrame = null;
window.requestAnimationFrame = function (callback) { window.testPendingFrame = callback; return 1; };
window.testErrors = [];
window.testMasks = [];
window.addEventListener('error', function (errorEvent) { window.testErrors.push(String(errorEvent.message)); });
</script>
${useBot ? '<script>\n' + fs.readFileSync(botPath, 'utf8') + '\n</script>\n' : ''}`;
    const driver = `<pre id="result"></pre>
<script>
(function () {
    let timestamp = 0;
    function runFrame() {
        timestamp += 1000 / 35 + 0.01;
        const callback = window.testPendingFrame;
        window.testPendingFrame = null;
        callback(timestamp);
    }
    try {
        runFrame();
        runFrame();
        for (const character of '${CHEAT_CODE}') {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: character, code: 'Key' + character.toUpperCase(), cancelable: true }));
        }
        for (let frame = 0; frame < ${MAX_FRAMES} && !window.testSummary().demoOver; frame++) { runFrame(); }
        for (let frame = 0; frame < ${FRAMES_AFTER_DEMO}; frame++) { runFrame(); }
    } catch (error) {
        window.testErrors.push('driver: ' + error.message);
    }
    const entries = [];
    let runStart = 0;
    for (let ticIndex = 1; ticIndex <= window.testMasks.length; ticIndex++) {
        if (ticIndex === window.testMasks.length || window.testMasks[ticIndex] !== window.testMasks[runStart]) {
            entries.push(window.testMasks[runStart] + '*' + (ticIndex - runStart));
            runStart = ticIndex;
        }
    }
    document.getElementById('result').textContent = '${RESULT_START}'
        + JSON.stringify({ summary: window.testSummary(), input: entries.join(','), errors: window.testErrors }) + '${RESULT_END}';
}());
</script>
`;
    if (page.split('<script>').length !== 2 || page.split('</script>').length !== 2) {
        throw new Error('Expected exactly one script element in index.html.');
    }
    return page.replace('</script>', () => '</script>\n' + driver).replace('<script>', () => prelude + '<script>');
}

function runPage(page, workPath, name) {
    const pagePath = path.join(workPath, name + '.html');
    fs.writeFileSync(pagePath, page);
    const output = childProcess.execFileSync(edgePath(), [
        '--headless', '--disable-gpu', '--no-first-run', '--autoplay-policy=no-user-gesture-required',
        '--user-data-dir=' + path.join(workPath, name + '_profile'), '--dump-dom', 'file:///' + pagePath.replace(/\\/g, '/')
    ], { encoding: 'utf8', timeout: EDGE_TIMEOUT_MILLISECONDS, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    // The page's own script text also holds the two markers, after the result element, so the search starts at that element.
    const elementStart = output.indexOf('<pre id="result">');
    const start = output.indexOf(RESULT_START, elementStart);
    const end = output.indexOf(RESULT_END, start);
    if (elementStart < 0 || start !== elementStart + '<pre id="result">'.length || end < start) { throw new Error('The ' + name + ' page printed no result. Its script did not run to the end.'); }
    const result = JSON.parse(output.slice(start + RESULT_START.length, end).replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    if (result.errors.length > 0) { throw new Error('The ' + name + ' page reported errors: ' + JSON.stringify(result.errors)); }
    return result;
}

function requireCompleteRun(summary, name) {
    const complete = summary.finished && summary.kills === summary.monsters && summary.itemsLeft === 0;
    if (!complete) { throw new Error('The ' + name + ' run is incomplete: ' + JSON.stringify(summary)); }
}

function embedInput(gamePage, input) {
    if (!/^\d+\*\d+(,\d+\*\d+)*$/.test(input)) { throw new Error('The recorded input has an unexpected format.'); }
    const pieces = [];
    let rest = input;
    while (rest.length > INPUT_LINE_LENGTH) {
        const cut = rest.lastIndexOf(',', INPUT_LINE_LENGTH) + 1;
        pieces.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    pieces.push(rest);
    const lineEnding = gamePage.includes('\r\n') ? '\r\n' : '\n';
    const pattern = /    const DEMO_INPUT = '[^;]*';/g;
    const matches = gamePage.match(pattern);
    if (matches === null || matches.length !== 1) { throw new Error('Expected exactly one DEMO_INPUT constant in index.html.'); }
    return gamePage.replace(pattern, () => "    const DEMO_INPUT = '" + pieces.join("'" + lineEnding + "        + '") + "';");
}

function main() {
    const workPath = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-lite-demo-'));
    try {
        const gamePage = fs.readFileSync(indexPath, 'utf8');
        const recording = runPage(buildTestPage(gamePage, true), workPath, 'recording');
        requireCompleteRun(recording.summary, 'recording');
        const updatedPage = embedInput(gamePage, recording.input);
        const playback = runPage(buildTestPage(updatedPage, false), workPath, 'playback');
        requireCompleteRun(playback.summary, 'playback');
        const recorded = JSON.stringify(recording.summary);
        const played = JSON.stringify(playback.summary);
        if (recorded !== played) { throw new Error('Playback differs from the recording. Recording: ' + recorded + ' Playback: ' + played); }
        const changed = updatedPage !== gamePage;
        if (changed) { fs.writeFileSync(indexPath, updatedPage); }
        console.log('PASS: ' + recording.summary.tics + ' tics, kills ' + recording.summary.kills + '/' + recording.summary.monsters
            + ', items left ' + recording.summary.itemsLeft + ', health ' + recording.summary.health + '. index.html '
            + (changed ? 'now holds this recording.' : 'already held this recording.'));
    } finally {
        fs.rmSync(workPath, { recursive: true, force: true });
    }
}

main();
