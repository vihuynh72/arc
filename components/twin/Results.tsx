// Search results as a plain list the reading cursor can move through. Used by components/Twin.tsx.
export type Result = { title: string; url: string; snippet: string };

type Props = {
  query: string;
  results: Result[];
  ids: string[]; // cursor ids, one per result
  onOpen: (url: string) => void;
  onBack: () => void;
};

export default function Results({ query, results, ids, onOpen, onBack }: Props) {
  return (
    <section aria-labelledby="results-title">
      <h1 id="results-title">Search results for {query}</h1>
      <p>
        <button type="button" onClick={onBack}>
          Back to the page
        </button>
      </p>
      {results.length === 0 && <p>No results.</p>}
      <ol>
        {results.map((r, i) => (
          <li key={ids[i]} data-node-id={ids[i]}>
            <h2 data-cursor>{r.title}</h2>
            <p>{r.snippet}</p>
            <p>
              <a href={r.url}>{r.url}</a>{" "}
              <button type="button" onClick={() => onOpen(r.url)}>
                Open this page
              </button>
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
