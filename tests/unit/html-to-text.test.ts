import { describe, expect, it } from 'vitest';
import { htmlToText } from '../../server/sources/html-to-text';

describe('htmlToText', () => {
  it('drops <style>/<script> bodies, strips tags, decodes entities, collapses whitespace', () => {
    const html = '<style>td {padding-top:37px!important} .view-all-section a {font-size:20px}</style>'
      + '<p>Any update on these guys?&nbsp; Thanks.&nbsp;Regards,&nbsp;Eric &amp; team &lt;x&gt; &#39;ok&#39;</p><script>alert(1)</script>';
    expect(htmlToText(html)).toBe("Any update on these guys? Thanks. Regards, Eric & team <x> 'ok'");
  });

  // 2026-09-23 review I-4: String.fromCodePoint throws RangeError above 0x10FFFF, which killed the
  // whole M365 feed on one malformed entity. Out-of-range numeric entities pass through unchanged.
  it('leaves an out-of-range numeric entity in place instead of throwing (I-4)', () => {
    expect(() => htmlToText('a &#x110000; b')).not.toThrow();
    expect(htmlToText('a &#x110000; b')).toBe('a &#x110000; b');
    expect(() => htmlToText('a &#99999999; b')).not.toThrow();
    expect(htmlToText('a &#99999999; b')).toBe('a &#99999999; b');
    // In-range code points still decode.
    expect(htmlToText('&#x1F600; &#65;')).toBe('\u{1F600} A');
  });

  it('decodes the typographic named entities Outlook bodies use (T13)', () => {
    expect(htmlToText('Eric&rsquo;s &lsquo;plan&rsquo; &ldquo;quoted&rdquo; a&mdash;b c&ndash;d wait&hellip;'))
      .toBe('Eric\u2019s \u2018plan\u2019 \u201Cquoted\u201D a\u2014b c\u2013d wait\u2026');
  });

  it('strips an UNCLOSED <style> / <script> / <head> from its opening tag to the end of the string (T13)', () => {
    expect(htmlToText('<p>Hello</p><style>td {padding: 0} .x {color: red}')).toBe('Hello');
    expect(htmlToText('<p>Hello</p><script>var x = 1; alert(x)')).toBe('Hello');
    expect(htmlToText('<p>Hello</p><head><meta charset="utf-8"><title>t</title>')).toBe('Hello');
    // A closed block followed by an unclosed one: both go.
    expect(htmlToText('<style>a{}</style><p>Hello</p><script>unclosed')).toBe('Hello');
  });
});
