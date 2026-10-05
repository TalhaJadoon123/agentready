/** Debug: fetch the demo homepage and see what the scanner's fetcher receives. */
import { fetchOnce } from '../packages/core/dist/fetcher.js';
import { parsePage, extractJsonLd, stripTags } from '../packages/core/dist/parser.js';

const res = await fetchOnce(fetch, 'http://localhost:8790/');
console.log('status:', res.status);
console.log('ok:', res.ok);
console.log('content-type:', res.contentType);
console.log('headers:', JSON.stringify(res.headers).slice(0, 200));
console.log('body length:', res.body.length);
console.log('body head:', JSON.stringify(res.body.slice(0, 300)));
console.log('---');
const page = parsePage(res.body, 'http://localhost:8790/');
console.log('title:', page.title);
console.log('wordCount:', page.wordCount);
console.log('jsonLd nodes:', page.jsonLd.length);
console.log('text preview:', JSON.stringify(page.text.slice(0, 200)));
console.log('extractJsonLd direct:', extractJsonLd(res.body).length);
console.log('stripTags:', JSON.stringify(stripTags(res.body.slice(0, 200))));