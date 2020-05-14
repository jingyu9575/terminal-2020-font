"use strict";

const build = require("verda").create();
const { task, file, oracle, phony, computed } = build.ruleTypes;
const { de, fu } = build.rules;
const { run, node, rm, cd, mv, cp } = build.actions;
const { FileList } = build.predefinedFuncs;

const fs = require("fs-extra");
const path = require("path");
const os = require("os");

build.setJournal(`build/.verda-build-journal`);
build.setSelfTracking();
module.exports = build;

// Directories
const PREFIX = `terminal-2020`;
const BUILD = `build`;
const OUT = `out`;
const SOURCES = `sources`;

// Command line
const NODEJS = `node`;
const SEVEN_ZIP = `7z`;
const OTFCCDUMP = `otfccdump`;
const OTFCCBUILD = `otfccbuild`;
const OTF2TTF = `otf2ttf`;
const OTC2OTF = `otc2otf`;

const NPX_SUFFIX = os.platform() === "win32" ? ".cmd" : "";
const TTCIZE = "node_modules/.bin/otfcc-ttcize" + NPX_SUFFIX;
const Chlorophytum = [NODEJS, `./node_modules/@chlorophytum/cli/bin/_startup`];

///////////////////////////////////////////////////////////////////////////////////////////////////
// Entrypoint
const Start = phony("all", async t => {
	await t.need(TtfFontFiles);
	await t.need(TtcFontFiles);
	await t.need(Ttf, Ttc);
});

const Ttc = phony(`ttc`, async t => {
	const version = await t.need(Version);
	await t.need(TTCArchive(version));
});

const Ttf = phony(`ttf`, async t => {
	const version = await t.need(Version);
	await t.need(TTFArchive(version));
});

const Dependencies = oracle("oracles::dependencies", async () => {
	const pkg = await fs.readJSON(__dirname + "/package.json");
	const depJson = {};
	for (const pkgName in pkg.dependencies) {
		const depPkg = await fs.readJSON(__dirname + "/node_modules/" + pkgName + "/package.json");
		const depVer = depPkg.version;
		depJson[pkgName] = depVer;
	}
	return { requirements: pkg.dependencies, actual: depJson };
});

const Version = oracle("oracles::version", async t => {
	return (await fs.readJson(path.resolve(__dirname, "package.json"))).version;
});

const TTCArchive = file.make(
	version => `${OUT}/terminal-2020-ttc-${version}.7z`,
	async (t, target) => {
		await t.need(TtcFontFiles);
		await rm(target.full);
		await SevenZipCompress(`${OUT}/ttc`, target, `*.ttc`);
	}
);
const TTFArchive = file.make(
	version => `${OUT}/terminal-2020-ttf-${version}.7z`,
	async (t, target) => {
		const [config] = await t.need(Config, de`${OUT}/ttf`);
		await t.need(TtfFontFiles);

		// StyleOrder is interlaced with "upright" and "italic"
		// Compressing in this order reduces archive size
		await rm(target.full);
		for (let j = 0; j < config.styleOrder.length; j += 2) {
			const styleUpright = config.styleOrder[j];
			const styleItalic = config.styleOrder[j + 1];
			await SevenZipCompress(
				`${OUT}/ttf`,
				target,
				styleUpright ? `*-${styleUpright}.ttf` : null,
				styleItalic ? `*-${styleItalic}.ttf` : null
			);
		}
	}
);

function SevenZipCompress(dir, target, ...inputs) {
	return cd(dir).run(
		[SEVEN_ZIP, `a`],
		[`-t7z`, `-mmt=on`, `-m0=LZMA:a=0:d=256m:fb=256`],
		[`../${target.name}.7z`, ...inputs]
	);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// TTF Building

const BreakShsTtc = task.make(
	weight => `break-ttc::${weight}`,
	async ($, weight) => {
		const [config] = await $.need(Config, de(`${BUILD}/shs`));
		const shsSourceMap = config.shsSourceMap;
		await run(
			OTC2OTF,
			`${SOURCES}/shs/${shsSourceMap.defaultRegion}-${shsSourceMap.style[weight]}.ttc`
		);
		for (const regionID in shsSourceMap.region) {
			const region = shsSourceMap.region[regionID];
			const partName = `${region}-${shsSourceMap.style[weight]}.otf`;
			if (await fs.pathExists(`${SOURCES}/shs/${partName}`)) {
				await rm(`${BUILD}/shs/${partName}`);
				await mv(`${SOURCES}/shs/${partName}`, `${BUILD}/shs/${partName}`);
			}
		}
	}
);

const ShsOtd = file.make(
	(region, weight) => `${BUILD}/shs/${region}-${weight}.otd`,
	async (t, output, region, weight) => {
		const [config] = await t.need(Config, BreakShsTtc(weight));
		const shsSourceMap = config.shsSourceMap;
		const [, $1] = await t.need(
			de(output.dir),
			fu`${BUILD}/shs/${shsSourceMap.region[region]}-${shsSourceMap.style[weight]}.otf`
		);
		const temp = `${output.dir}/${output.name}.tmp.ttf`;
		// I hope SHS' HMTX LSBs are correct
		await run(OTF2TTF, [`-o`, temp], $1.full);
		// ... if not, use this instead
		// await RunFontBuildTask("make/quadify/index.js", { main: temp, o: $1.full + ".tmp.ttf" });
		await run(OTFCCDUMP, `-o`, output.full, temp);
	}
);

const NonKanji = file.make(
	(region, style) => `${BUILD}/non-kanji0/${region}-${style}.ttf`,
	async (t, { full, dir, name }, region, style) => {
		await t.need(Config, Scripts);
		const [$1] = await t.need(ShsOtd(region, style), de(dir));
		const tmpOTD = `${dir}/${name}.otd`;
		await RunFontBuildTask("make/non-kanji/build.js", {
			main: $1.full,
			o: tmpOTD
		});
		await OtfccBuildAsIs(tmpOTD, full);
	}
);

const WS0 = file.make(
	(family, region, style) => `${BUILD}/ws0/${family}-${region}-${style}.ttf`,
	async (t, { full, dir, name }, family, region, style) => {
		const [config] = await t.need(Config, Scripts);
		const [, $1] = await t.need(de(dir), NonKanji(region, style));
		const tmpOTD = `${dir}/${name}.otd`;
		await RunFontBuildTask("make/punct/ws.js", {
			main: $1.full,
			o: tmpOTD,
			mono: config.families[family].isMono || false,
			type: config.families[family].isType || false,
			pwid: config.families[family].isPWID || false,
			term: config.families[family].isTerm || false
		});
		await OtfccBuildAsIs(tmpOTD, full);
	}
);

const AS0 = file.make(
	(family, region, style) => `${BUILD}/as0/${family}-${region}-${style}.ttf`,
	async (t, { full, dir, name }, family, region, style) => {
		const [config] = await t.need(Config, Scripts);
		const [, $1] = await t.need(de(dir), NonKanji(region, style));
		const tmpOTD = `${dir}/${name}.otd`;
		await RunFontBuildTask("make/punct/as.js", {
			main: $1.full,
			o: tmpOTD,
			mono: config.families[family].isMono || false,
			type: config.families[family].isType || false,
			pwid: config.families[family].isPWID || false,
			term: config.families[family].isTerm || false
		});
		await OtfccBuildAsIs(tmpOTD, full);
	}
);

const LatinSource = file.make(
	(group, style) => `${BUILD}/latin-${group}/${group}-${style}.ttf`,
	async (t, out, group, style) => {
		const [config] = await t.need(Config, Scripts, de(out.dir));
		const latinCfg = config.latinGroups[group] || {};
		let sourceStyle = style;
		if (latinCfg.styleToFileSuffixMap) {
			sourceStyle = latinCfg.styleToFileSuffixMap[style] || style;
		}
		const isCff = latinCfg.isCff;
		const sourceFile = `sources/${group}/${group}-${sourceStyle}` + (isCff ? ".otf" : ".ttf");
		const [source] = await t.need(fu(sourceFile));
		if (isCff) {
			await RunFontBuildTask("make/quadify/index.js", { main: source.full, o: out.full });
		} else {
			await cp(source.full, out.full);
		}
	}
);

const Pass1 = file.make(
	(family, region, style) => `${BUILD}/pass1/${family}-${region}-${style}.ttf`,
	async (t, { full, dir, name }, family, region, style) => {
		const [config] = await t.need(Config, Scripts);
		const latinFamily = config.families[family].latinGroup;
		const [, $1, $2, $3] = await t.need(
			de(dir),
			LatinSource(latinFamily, style),
			AS0(family, region, deItalizedNameOf(config, style)),
			WS0(family, region, deItalizedNameOf(config, style))
		);
		await RunFontBuildTask("make/pass1/build.js", {
			main: $1.full,
			asian: $2.full,
			ws: $3.full,
			o: full + ".tmp.ttf",

			family: family,
			subfamily: config.subfamilies[region].name,
			style: style,
			italize: deItalizedNameOf(config, name) === name ? false : true,

			mono: config.families[family].isMono || false,
			type: config.families[family].isType || false,
			pwid: config.families[family].isPWID || false,
			term: config.families[family].isTerm || false
		});
		await run("ttfautohint", full + ".tmp.ttf", full);
		await rm(full + ".tmp.ttf");
	}
);

const Kanji0 = file.make(
	(region, style) => `${BUILD}/kanji0/${region}-${style}.ttf`,
	async (t, { full, dir, name }, region, style) => {
		await t.need(Config, Scripts);
		const [$1] = await t.need(ShsOtd(region, style), de(dir));
		const tmpOTD = `${dir}/${name}.otd`;
		await RunFontBuildTask("make/kanji/build.js", {
			main: $1.full,
			o: tmpOTD
		});
		await OtfccBuildAsIs(tmpOTD, full);
	}
);
const Hangul0 = file.make(
	(region, style) => `${BUILD}/hangul0/${region}-${style}.ttf`,
	async (t, { full, dir, name }, region, style) => {
		await t.need(Config, Scripts);
		const [$1] = await t.need(ShsOtd(region, style), de(dir));
		const tmpOTD = `${dir}/${name}.otd`;
		await RunFontBuildTask("make/hangul/build.js", {
			main: $1.full,
			o: tmpOTD
		});
		await OtfccBuildAsIs(tmpOTD, full);
	}
);

const Prod = file.make(
	(family, region, style) => `${OUT}/ttf/${PREFIX}-${family}-${region}-${style}.ttf`,
	async (t, { full, dir, name }, family, region, style) => {
		const [config] = await t.need(Config, Scripts, Version);
		const weight = deItalizedNameOf(config, style);
		const [, $1, $2, $3] = await t.need(
			de(dir),
			HfoPass1(weight, family, region, style),
			HfoKanji(weight, region, weight),
			HfoHangul(weight, region, weight)
		);
		const tmpOTD = `${dir}/${name}.otd`;
		await RunFontBuildTask("make/pass2/build.js", {
			main: $1.full,
			kanji: $2.full,
			hangul: $3.full,
			o: tmpOTD,
			italize: weight === style ? false : true
		});
		await OtfccBuildOptimize(tmpOTD, full);
	}
);

///////////////////////////////////////////////////////////////////////////////////////////////////
// HINTING

const HintDirPrefix = `${BUILD}/hf`;
const HintDirOutPrefix = `${BUILD}/hfo`;

const JHint = oracle("hinting-jobs", async () => os.cpus().length);
const KanjiInTtf = file.make(
	(weight, region, style) => `${HintDirPrefix}-${weight}/kanji-${region}-${style}.ttf`,
	async (t, out, weight, region, style) => {
		const [k0ttf] = await t.need(Kanji0(region, style), de(out.dir));
		await cp(k0ttf.full, out.full);
	}
);
const HangulInTtf = file.make(
	(weight, region, style) => `${HintDirPrefix}-${weight}/hangul-${region}-${style}.ttf`,
	async (t, out, weight, region, style) => {
		const [k0ttf] = await t.need(Hangul0(region, style), de(out.dir));
		await cp(k0ttf.full, out.full);
	}
);
const Pass1Ttf = file.make(
	(weight, family, region, style) =>
		`${HintDirPrefix}-${weight}/pass1-${family}-${region}-${style}.ttf`,
	async (t, out, weight, family, region, style) => {
		const [k0ttf] = await t.need(Pass1(family, region, style), de(out.dir));
		await cp(k0ttf.full, out.full);
	}
);

const GroupHintStyleList = computed(`group-hint-style-list`, async t => {
	const [config] = await t.need(Config);
	const results = [];
	for (const style in config.styles) {
		if (config.styles[style].uprightStyleMap) continue;
		await results.push(style);
	}
	return results;
});

const GroupHintSelf = task.make(
	weight => `group-hint-self::${weight}`,
	async (t, weight) => {
		const [config, jHint, hintParam] = await t.need(
			Config,
			JHint,
			fu`hinting-params/${weight}.json`
		);

		const [kanjiDeps, pass1Deps] = HintingDeps(config, weight);
		const [kanjiTtfs, pass1Ttfs] = await t.need(kanjiDeps, pass1Deps);

		await run(
			Chlorophytum,
			`hint`,
			[`-c`, hintParam.full],
			[`-h`, `${HintDirPrefix}-${weight}/cache.gz`],
			[`--jobs`, jHint],
			[...HintParams([...kanjiTtfs, ...pass1Ttfs])]
		);
	}
);

const GroupHintDependent = task.make(
	weight => `group-hint-dependent::${weight}`,
	async (t, weight) => {
		const [styleList] = await t.need(GroupHintStyleList);
		const weightIndex = styleList.indexOf(weight);
		if (weightIndex > 0) await t.need(GroupHintDependent(styleList[weightIndex - 1]));
		await t.need(GroupHintSelf(weight));
	}
);

const GroupInstr = task.make(
	weight => `group-instr::${weight}`,
	async (t, weight) => {
		const [config, hintParam] = await t.need(Config, fu`hinting-params/${weight}.json`);
		const [kanjiDeps, pass1Deps] = HintingDeps(config, weight);
		const [kanjiTtfs, pass1Ttfs] = await t.need(kanjiDeps, pass1Deps);
		await t.need(GroupHintDependent(weight));

		await run(
			Chlorophytum,
			`instruct`,
			[`-c`, hintParam.full],
			[...InstrParams([...kanjiTtfs, ...pass1Ttfs])]
		);
	}
);
const GroupInstrAll = task(`group-instr-all`, async t => {
	const [styleList] = await t.need(GroupHintStyleList);
	await t.need(styleList.map(w => GroupInstr(w)));
});

const HfoKanji = file.make(
	(weight, region, style) => `${HintDirOutPrefix}-${weight}/kanji-${region}-${style}.ttf`,
	OutTtfMain
);
const HfoHangul = file.make(
	(weight, region, style) => `${HintDirOutPrefix}-${weight}/hangul-${region}-${style}.ttf`,
	OutTtfMain
);
const HfoPass1 = file.make(
	(weight, family, region, style) =>
		`${HintDirOutPrefix}-${weight}/pass1-${family}-${region}-${style}.ttf`,
	OutTtfMain
);
async function OutTtfMain(t, out, weight) {
	const [hintParam] = await t.need(
		fu`hinting-params/${weight}.json`,
		de`${HintDirOutPrefix}-${weight}`,
		GroupInstrAll
	);
	await run(
		Chlorophytum,
		`integrate`,
		[`-c`, hintParam.full],
		[
			`${HintDirPrefix}-${weight}/${out.name}.instr.gz`,
			`${HintDirPrefix}-${weight}/${out.name}.ttf`,
			out.full
		]
	);
}

// Support functions
function HintingDeps(config, weight) {
	const kanjiDeps = [];
	for (let sf of config.subfamilyOrder) {
		kanjiDeps.push(KanjiInTtf(weight, sf, weight));
		kanjiDeps.push(HangulInTtf(weight, sf, weight));
	}

	const pass1Deps = [];
	for (let f of config.familyOrder) {
		for (let sf of config.subfamilyOrder) {
			for (const style in config.styles) {
				if (deItalizedNameOf(config, style) !== weight) continue;
				pass1Deps.push(Pass1Ttf(weight, f, sf, style));
			}
		}
	}

	return [kanjiDeps, pass1Deps];
}
function* HintParams(otds) {
	for (const otd of otds) {
		yield otd.full;
		yield `${otd.dir}/${otd.name}.hint.gz`;
	}
}
function* InstrParams(otds) {
	for (const otd of otds) {
		yield otd.full;
		yield `${otd.dir}/${otd.name}.hint.gz`;
		yield `${otd.dir}/${otd.name}.instr.gz`;
	}
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// TTC building
const TTCFile = file.make(
	style => `${OUT}/ttc/${PREFIX}-${style}.ttc`,
	async (t, out, style) => {
		const [config] = await t.need(Config, de`${OUT}/ttc`);

		let requirements = [];
		for (let family of config.familyOrder) {
			for (let region of config.subfamilyOrder) {
				requirements.push(Prod(family, region, style));
			}
		}

		const [$$] = await t.need(requirements);
		await rm(out.full);
		await run(
			TTCIZE,
			["-x", "--common-width", 1000, "--common-height", 1000],
			["-o", out.full],
			[...$$.map(t => t.full)]
		);
	}
);

const TtcFontFiles = task("intermediate::ttcFontFiles", async t => {
	const [config] = await t.need(Config, de`${OUT}/ttc`);

	await t.need(config.styleOrder.map(st => TTCFile(st)));
});

const TtfFontFiles = task("intermediate::ttfFontFiles", async t => {
	const [config] = await t.need(Config, de`${OUT}/ttf`);
	let reqs = [];
	for (let f of config.familyOrder)
		for (let sf of config.subfamilyOrder)
			for (let st of config.styleOrder) {
				reqs.push(Prod(f, sf, st));
			}
	await t.need(...reqs);
});

///////////////////////////////////////////////////////////////////////////////////////////////////
// Build Scripts & Config
const ScriptsStructure = oracle("dep::scripts-dir-structure", target =>
	FileList({ under: `make`, pattern: `**/*.js` })(target)
);

const Scripts = task("dep::scripts", async t => {
	await t.need(Dependencies);
	const [scriptList] = await t.need(ScriptsStructure);
	await t.need(scriptList.map(fu));
});

const Config = oracle("dep::config", async () => {
	return await fs.readJSON(__dirname + "/config.json");
});

///////////////////////////////////////////////////////////////////////////////////////////////////
// CLI wrappers
async function OtfccBuildOptimize(from, to) {
	await run(OTFCCBUILD, from, [`-o`, to], [`-O3`, `-s`, `--keep-average-char-width`, `-q`]);
	await rm(from);
}
async function OtfccBuildAsIs(from, to) {
	await run(OTFCCBUILD, from, [`-o`, to], [`-k`, `-s`, `--keep-average-char-width`, `-q`]);
	await rm(from);
}
async function RunFontBuildTask(recipe, args) {
	return await node("./run", recipe, args);
}

function deItalizedNameOf(config, set) {
	return (set + "")
		.split("-")
		.map(w => (config.styles[w] ? config.styles[w].uprightStyleMap || w : w))
		.join("-");
}
