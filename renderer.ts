
/*
 * renderer.ts
 *
 * This module exposes a function that turns an Obsidian markdown string into
 * an HTML string with as many inconsistencies ironed out as possible
 *
 */

import * as path from 'path';
import * as fs from 'fs';
import * as YAML from 'yaml';
import { Base64 } from 'js-base64';

import { FileSystemAdapter, MarkdownRenderer, MarkdownView, Notice } from 'obsidian';

import PandocPlugin from './main';
import { PandocPluginSettings } from './global';
import mathJaxFontCSS from './styles/mathjax-css';
import appCSS, { variables as appCSSVariables } from './styles/app-css';
import { outputFormats } from 'pandoc';

// Note: parentFiles is for internal use (to prevent recursively embedded notes)
// inputFile must be an absolute file path
export default async function render (plugin: PandocPlugin, view: MarkdownView,
    inputFile: string, outputFormat: string, parentFiles: string[] = []):
    Promise<{ html: string, metadata: { [index: string]: string } }>
{
    // Use Obsidian's markdown renderer to render to a hidden <div>
    const markdown = view.data;
    const wrapper = document.createElement('div');
    wrapper.style.display = 'hidden';
    document.body.appendChild(wrapper);
    await MarkdownRenderer.renderMarkdown(markdown, wrapper, path.dirname(inputFile), view);

    // Post-process the HTML in-place
    await postProcessRenderedHTML(plugin, inputFile, wrapper, outputFormat,
        parentFiles, await mermaidCSS(plugin.settings, plugin.vaultBasePath()));
    let html = wrapper.innerHTML;
    document.body.removeChild(wrapper);

    // If it's a top level note, make the HTML a standalone document - inject CSS, a <title>, etc.
    const metadata = getYAMLMetadata(markdown);
    metadata.title ??= fileBaseName(inputFile);
    if (parentFiles.length === 0) {
        html = await standaloneHTML(plugin.settings, html, metadata.title, plugin.vaultBasePath());
    }

    return { html, metadata };
}

// Takes any file path like '/home/oliver/zettelkasten/Obsidian.md' and
// takes the base name, in this case 'Obsidian'
function fileBaseName(file: string): string {
    return path.basename(file, path.extname(file));
}

// Resolves a filename to a TFile using Obsidian's link resolver with vault-wide search fallback
// This mimics Obsidian's "magic" behavior of finding files by name regardless of location
function resolveFileLink(filename: string, sourcePath: string, plugin: PandocPlugin): any | null {
    const adapter = plugin.app.vault.adapter as FileSystemAdapter;

    // Get vault-relative path without leading slash
    let vaultRelativePath = sourcePath.substring(adapter.getBasePath().length);
    if (vaultRelativePath.startsWith('/') || vaultRelativePath.startsWith('\\')) {
        vaultRelativePath = vaultRelativePath.substring(1);
    }

    // Try Obsidian's standard link resolver first
    let file = plugin.app.metadataCache.getFirstLinkpathDest(filename, vaultRelativePath);

    // If direct resolution fails, search the entire vault for the file
    if (!file) {
        console.log(`Pandoc plugin: Direct resolution failed for ${filename}, searching vault...`);

        // Get all files in the vault
        const allFiles = plugin.app.vault.getFiles();

        // Extract just the filename without path for comparison
        const targetFilename = filename.split('/').pop().split('\\').pop();

        // Search for a file with matching name
        file = allFiles.find(f => {
            const fName = f.name;
            const fBasename = f.basename; // filename without extension
            const fPath = f.path;

            // Try exact matches first
            if (fName === targetFilename) return true;
            if (fBasename === targetFilename) return true;
            if (fPath.endsWith(filename)) return true;

            // Try case-insensitive match as fallback
            if (fName.toLowerCase() === targetFilename.toLowerCase()) return true;

            return false;
        });

        if (file) {
            console.log(`Pandoc plugin: Found ${filename} via vault search → ${file.path}`);
        } else {
            console.warn(`Pandoc plugin: Could not resolve file link: ${filename} (source: ${vaultRelativePath})`);
        }
    }

    return file;
}

function getYAMLMetadata(markdown: string) {
    markdown = markdown.trim();
    if (markdown.startsWith('---')) {
        const trailing = markdown.substring(3);
        const frontmatter = trailing.substring(0, trailing.indexOf('---')).trim();
        return YAML.parse(frontmatter);
    }
    return {};
}

// Preprocesses markdown to convert Obsidian wiki-link image syntax to standard markdown
// This is needed for markdown export mode, where Pandoc doesn't understand ![[image.png]]
export async function preprocessMarkdownImages(
    markdown: string,
    inputFile: string,
    plugin: PandocPlugin
): Promise<string> {
    const adapter = plugin.app.vault.adapter as FileSystemAdapter;

    // Regex to match: ![[filename|width]] or ![[filename|widthxheight]] or ![[filename]]
    // Groups: 1=filename, 3=width, 5=height
    const wikiImageRegex = /!\[\[([^\]|]+)(\|(\d+)(x(\d+))?)?\]\]/g;

    let result = markdown;
    const matches = Array.from(markdown.matchAll(wikiImageRegex));

    for (const match of matches) {
        const fullMatch = match[0];
        const filename = match[1].trim();
        const width = match[3];
        const height = match[5];

        try {
            // Use shared resolution function
            const file = resolveFileLink(filename, inputFile, plugin);

            if (!file) {
                continue; // Keep original syntax if can't resolve
            }

            const absolutePath = adapter.getFullPath(file.path);
            console.log(`Pandoc plugin: Resolved ${filename} → ${file.path} → ${absolutePath}`);

            // Normalize path separators for cross-platform compatibility
            const normalizedPath = absolutePath.replace(/\\/g, '/');

            // Build standard markdown with file:// URL for Pandoc
            let replacement = `![${filename}](file://${normalizedPath})`;

            // Add Pandoc-style size attributes if dimensions were specified
            if (width || height) {
                const attrs: string[] = [];
                if (width) attrs.push(`width=${width}px`);
                if (height) attrs.push(`height=${height}px`);
                replacement += `{${attrs.join(' ')}}`;
            }

            // Replace this occurrence in the result
            result = result.replace(fullMatch, replacement);
        } catch (e) {
            console.error(`Pandoc plugin: Error processing image link ${filename}:`, e);
            // Keep original if there's an error
        }
    }

    return result;
}

async function getCustomCSS(settings: PandocPluginSettings, vaultBasePath: string): Promise<string> {
    if (!settings.customCSSFile) return;
    let file = settings.customCSSFile;
    let buffer: Buffer = null;
    // Try absolute path
    try {
        let test = await fs.promises.readFile(file);
        buffer = test;
    } catch(e) { }
    // Try relative path
    try {
        let test = await fs.promises.readFile(path.join(vaultBasePath, file));
        buffer = test;
    } catch(e) { }

    if(!buffer) {
        new Notice('Failed to load custom Pandoc CSS file: ' + settings.customCSSFile);
        return '';
    } else {
        return buffer.toString();
    }
}

async function getAppConfig(vaultBasePath: string): Promise<any> {
    return JSON.parse((await fs.promises.readFile(path.join(vaultBasePath, '.obsidian', 'config'))).toString());
}

async function currentThemeIsLight(vaultBasePath: string, config: any = null): Promise<boolean> {
    try {
        if (!config) config = await getAppConfig(vaultBasePath);
        return config.theme !== 'obsidian';
    } catch (e) {
        return true;
    }
}

async function mermaidCSS(settings: PandocPluginSettings, vaultBasePath: string): Promise<string> {
    // We always inject CSS into Mermaid diagrams, using light theme if the user has requested no CSS
    //   otherwise the diagrams look terrible. The output is a PNG either way
    let light = true;
    if (settings.injectAppCSS === 'dark') light = false;
    if (settings.injectAppCSS === 'current') {
        light = await currentThemeIsLight(vaultBasePath);
    }
    return appCSSVariables(light);
}

// Gets a small subset of app CSS and 3rd party theme CSS if desired
async function getThemeCSS(settings: PandocPluginSettings, vaultBasePath: string): Promise<string> {
    if (settings.injectAppCSS === 'none') return '';
    try {
        const config = await getAppConfig(vaultBasePath);
        let light = await currentThemeIsLight(vaultBasePath, config);
        if (settings.injectAppCSS === 'light') light = true;
        if (settings.injectAppCSS === 'dark') light = false;
        return appCSS(light);
    } catch (e) {
        return '';
    }
}

async function getDesiredCSS(settings: PandocPluginSettings, html: string, vaultBasePath: string): Promise<string> {
    let css = await getThemeCSS(settings, vaultBasePath);
    if (settings.injectAppCSS !== 'none') {
        css += ' ' + Array.from(document.querySelectorAll('style'))
            .map(s => s.innerHTML).join(' ');
    }
    // Inject MathJax font CSS if needed (at this stage embedded notes are
    //  already embedded so doesn't duplicate CSS)
    if (html.indexOf('jax="CHTML"') !== -1)
        css += ' ' + mathJaxFontCSS;
    // Inject custom local CSS file if it exists
    css += await getCustomCSS(settings, vaultBasePath);
    return css;
}

async function standaloneHTML(settings: PandocPluginSettings, html: string, title: string, vaultBasePath: string): Promise<string> {
    // Wraps an HTML fragment in a proper document structure
    //  and injects the page's CSS
    const css = await getDesiredCSS(settings, html, vaultBasePath);

    return `<!doctype html>\n` +
        `<html>\n` +
        `    <head>\n` +
        `        <title>${title}</title>\n` +
        `        <meta charset='utf-8'/>\n` +
        `        <style>\n${css}\n</style>\n` +
        `    </head>\n` +
        `    <body>\n` +
        `${html}\n` +
        `    </body>\n` +
        `</html>`;
}

async function postProcessRenderedHTML(plugin: PandocPlugin, inputFile: string, wrapper: HTMLElement,
    outputFormat: string, parentFiles: string[] = [], css: string = '')
{
    const dirname = path.dirname(inputFile);
    const adapter = plugin.app.vault.adapter as FileSystemAdapter;
    const settings = plugin.settings;
    // Fix <span src="image.png">
    for (let span of Array.from(wrapper.querySelectorAll('span[src$=".png"], span[src$=".jpg"], span[src$=".gif"], span[src$=".jpeg"]'))) {
        span.innerHTML = '';
        span.outerHTML = span.outerHTML.replace(/span/g, 'img');
    }
    // Fix <span class='internal-embed' src='another_note_without_extension'>
    for (let span of Array.from(wrapper.querySelectorAll('span.internal-embed'))) {
        let src = span.getAttribute('src');
        if (src) {
            // Use shared resolution function
            const file = resolveFileLink(src, inputFile, plugin);

            if (!file) {
                console.warn(`Pandoc plugin: Could not resolve embedded note: ${src}`);
                continue;
            }

            try {
                if (parentFiles.indexOf(file.path) !== -1) {
                    // We've got an infinite recursion on our hands
                    // We should replace the embed with a wikilink
                    // Then our link processing happens afterwards
                    span.outerHTML = `<a href="app://obsidian.md/${file.path}">${span.innerHTML || file.basename}</a>`;
                } else {
                    const markdown = await adapter.read(file.path);
                    const newParentFiles = [...parentFiles];
                    newParentFiles.push(inputFile);
                    // TODO: because of this cast, embedded notes won't be able to handle complex plugins (eg DataView)
                    const html = await render(plugin, { data: markdown } as MarkdownView, file.path, outputFormat, newParentFiles);
                    span.outerHTML = html.html;
                }
            } catch (e) {
                // Continue if it can't be loaded
                console.error("Pandoc plugin encountered an error trying to load an embedded note: " + e.toString());
            }
        }
    }
    // Fix <a href="app://obsidian.md/markdown_file_without_extension">
    const prefix = 'app://obsidian.md/';
    for (let a of Array.from(wrapper.querySelectorAll('a'))) {
        if (!a.href.startsWith(prefix)) continue;
        // This is now an internal link (wikilink)
        if (settings.linkStrippingBehaviour === 'link' || outputFormat === 'html') {
            const linkTarget = decodeURIComponent(a.href.substring(prefix.length));

            // Extract anchor if present (e.g., "note#heading" -> "note" and "#heading")
            const hashIndex = linkTarget.indexOf('#');
            const baseLinkTarget = hashIndex !== -1 ? linkTarget.substring(0, hashIndex) : linkTarget;
            const anchor = hashIndex !== -1 ? linkTarget.substring(hashIndex) : '';

            // Use shared resolution function to find the file
            const file = resolveFileLink(baseLinkTarget, inputFile, plugin);

            if (file) {
                // File found - use its actual path
                let href = adapter.getFullPath(file.path);

                // Add extension if needed
                if (settings.addExtensionsToInternalLinks.length && path.extname(href) === '') {
                    href = href + '.' + settings.addExtensionsToInternalLinks;
                }

                // Add anchor back if it was present
                if (anchor) {
                    href = href + anchor;
                }

                a.href = href;
                console.log(`Pandoc plugin: Resolved link ${linkTarget} → ${file.path} → ${href}`);
            } else {
                // Fallback: couldn't resolve, keep relative path from current directory
                let href = path.join(dirname, linkTarget);
                if (settings.addExtensionsToInternalLinks.length && path.extname(href) === '') {
                    const base = path.basename(href);
                    const dir = path.dirname(href);
                    const hashIdx = base.indexOf('#');
                    if (hashIdx !== -1) {
                        href = path.join(dir, base.substring(0, hashIdx) + '.' + settings.addExtensionsToInternalLinks + base.substring(hashIdx));
                    } else {
                        href = path.join(dir, base + '.' + settings.addExtensionsToInternalLinks);
                    }
                }
                a.href = href;
                console.warn(`Pandoc plugin: Could not resolve link ${linkTarget}, using relative path`);
            }
        } else if (settings.linkStrippingBehaviour === 'strip') {
            a.outerHTML = '';
        } else if (settings.linkStrippingBehaviour === 'text') {
            a.outerHTML = a.innerText;
        } else if (settings.linkStrippingBehaviour === 'unchanged') {
            a.outerHTML = '[[' + a.outerHTML + ']]';
        }
    }
    // Fix <img src="app://obsidian.md/image.png">
    // Note: this will throw errors when Obsidian tries to load images with a (now invalid) src
    // These errors can be safely ignored
    if (outputFormat !== 'html') {
        for (let img of Array.from(wrapper.querySelectorAll('img'))) {
            if (img.src.startsWith(prefix) && img.getAttribute('data-touched') !== 'true') {
                // Decode URI components to handle spaces and special characters
                const encodedPath = img.src.substring(prefix.length);
                const decodedPath = decodeURIComponent(encodedPath);

                // Use shared resolution function to find the file (handles vault-wide search)
                const file = resolveFileLink(decodedPath, inputFile, plugin);

                let absolutePath: string;
                if (file) {
                    // File found via resolution - use its actual path
                    absolutePath = adapter.getFullPath(file.path);
                    console.log(`Pandoc plugin: Resolved image ${decodedPath} → ${file.path} → ${absolutePath}`);
                } else {
                    // Fallback to assuming the path is correct (for absolute/external paths)
                    absolutePath = adapter.getFullPath(decodedPath);
                    console.warn(`Pandoc plugin: Could not resolve image ${decodedPath}, using path as-is`);
                }

                // Use file:// URLs for better Pandoc compatibility across platforms
                // Normalize path separators for cross-platform support
                const normalizedPath = absolutePath.replace(/\\/g, '/');
                img.src = 'file://' + normalizedPath;

                img.setAttribute('data-touched', 'true');
            }
        }
    }
    // Remove YAML frontmatter from the output if desired
    if (!settings.displayYAMLFrontmatter) {
        Array.from(wrapper.querySelectorAll('.frontmatter, .frontmatter-container'))
            .forEach(el => wrapper.removeChild(el));
    }
    // Fix Mermaid.js diagrams
    for (let svg of Array.from(wrapper.querySelectorAll('svg'))) {
        // Insert the CSS variables as a CSS string (even if the user doesn't want CSS injected; Mermaid diagrams look terrible otherwise)
        // TODO: it injects light theme CSS, do we want this?
        let style: HTMLStyleElement = svg.querySelector('style') || svg.appendChild(document.createElement('style'));
        style.innerHTML += css;
        // Inject a marker (arrowhead) for Mermaid.js diagrams and use it at the end of paths
        svg.innerHTML += `"<marker id="mermaid_arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="strokeWidth" markerWidth="8" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" class="arrowheadPath" style="stroke-width: 1; stroke-dasharray: 1, 0;"></path></marker>"`;
        svg.innerHTML = svg.innerHTML.replace(/app:\/\/obsidian\.md\/index\.html#arrowhead\d*/g, "#mermaid_arrowhead");
        // If the output isn't HTML, replace the SVG with a PNG for compatibility
        if (outputFormat !== 'html') {
            const scale = settings.highDPIDiagrams ? 2 : 1;
            const png = await convertSVGToPNG(svg, scale);
            svg.parentNode.replaceChild(png, svg);
        }
    }
}

// This creates an unmounted <img> element with a transparent background PNG data URL as the src
// The scale parameter is used for high DPI renders (the <img> element size is the same,
//  but the underlying PNG is higher resolution)
function convertSVGToPNG(svg: SVGSVGElement, scale: number = 1): Promise<HTMLImageElement> {
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(svg.width.baseVal.value * scale);
    canvas.height = Math.ceil(svg.height.baseVal.value * scale);
    const ctx = canvas.getContext('2d');
    var svgImg = new Image;
    svgImg.src = "data:image/svg+xml;base64," + Base64.encode(svg.outerHTML);
    return new Promise((resolve, reject) => {
        svgImg.onload = () => {
            ctx.drawImage(svgImg, 0, 0, canvas.width, canvas.height);
            const pngData = canvas.toDataURL('png');
            const img = document.createElement('img');
            img.src = pngData;
            img.width = Math.ceil(svg.width.baseVal.value);
            img.height = Math.ceil(svg.height.baseVal.value);
            resolve(img);
        };
    });
}
