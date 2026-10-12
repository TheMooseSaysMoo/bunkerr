import { marked } from 'marked';
import { useMemo } from 'preact/hooks';
import { Loading, Panel, Prompt, useFetch } from '../components/ui';

export function Docs({ slug }: { slug?: string }) {
  const list = useFetch<{ slug: string; title: string }[]>('/api/docs');
  const doc = useFetch<{ slug: string; markdown: string }>(slug ? `/api/docs/${slug}` : null, [slug]);
  // Docs are repo files written by us (trusted), rendered as HTML.
  const html = useMemo(() => (doc.data ? (marked.parse(doc.data.markdown, { async: false }) as string) : ''), [doc.data]);

  if (!slug) {
    return (
      <>
        <Prompt title="docs" sub="man bunkerr" />
        {!list.data ? <Loading error={list.error} /> : (
          <Panel title="index" flush>
            <ul class="list">
              {list.data.map((d) => (
                <li key={d.slug}><span class="muted" aria-hidden="true">›</span><a class="grow" href={`#/docs/${d.slug}`}>{d.title}</a><span class="muted small only-desktop">{d.slug}.md</span></li>
              ))}
            </ul>
          </Panel>
        )}
      </>
    );
  }

  return (
    <>
      <Prompt title={`cat ${slug}.md`}><a class="btn sm" href="#/docs">← index</a></Prompt>
      {!doc.data ? <Loading error={doc.error} /> : <article class="panel"><div class="pb md" dangerouslySetInnerHTML={{ __html: html }} /></article>}
    </>
  );
}
