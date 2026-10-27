/**
 * The smallest XML reader an MPD needs: elements, attributes and text, no
 * namespaces, no entities beyond the five predefined ones. Workers have no
 * DOMParser, and the manifest is read in one.
 */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos);/g, (_, e: string) => ENTITIES[e] ?? _);
}

export function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const re =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<\s*([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const attrRe = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const top = stack[stack.length - 1] as XmlNode;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) {
      if (stack.length > 1) stack.pop();
    } else if (m[3] !== undefined) {
      const node: XmlNode = { name: m[3].replace(/^.*:/, ''), attrs: {}, children: [], text: '' };
      for (let a = attrRe.exec(m[4] ?? ''); a; a = attrRe.exec(m[4] ?? '')) {
        node.attrs[(a[1] as string).replace(/^.*:/, '')] = decodeEntities(a[2] ?? a[3] ?? '');
      }
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.text += decodeEntities(m[6]);
  }
  return root;
}

export function find(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}

export function findAll(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name);
}
