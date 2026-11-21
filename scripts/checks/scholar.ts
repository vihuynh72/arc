// Offline checks for lib/server/scholar.ts and lib/server/reddit.ts: URL to identifier, title matching thresholds, the inverted-index
// abstract, open-copy ranking, paywall detection on saved snippets, and Reddit parsing from saved samples. No network.
import assert from "node:assert";
import { paywalled } from "../../lib/parse/html";
import { rebuildAbstract } from "../../lib/server/openalex";
import { fromScraper, parseListingFeed, parseThreadFeed, redditLink, threadTwin } from "../../lib/server/reddit";
import { scholarly, spacedText } from "../../lib/server/search";
import { arxivEntries, cleanName, detailsText, names, sameTitle, withNote, arxivLoad, arxivMatch, parseJats, copiesOf, withHalFile, isPreview, keptFresh, metadataTwin, resolve, searchWorks, setTransport, doiIn, hitsOf, identify, parsePubmed, pickByTitle, scholarKind, siblingCopies, strongOf, titleSimilarity, type OaWork } from "../../lib/server/scholar";
import type { Twin } from "../../lib/types";

export default async function check() {
  // URL -> identifier
  const ids: [string, string | null][] = [
    ["https://www.sciencedirect.com/science/article/pii/S0893608014002135", "pii:S0893608014002135"],
    ["https://www.sciencedirect.com/science/article/abs/pii/S1566253521002360?via%3Dihub", "pii:S1566253521002360"],
    ["https://doi.org/10.1371/journal.pone.0185809", "doi:10.1371/journal.pone.0185809"],
    ["https://onlinelibrary.wiley.com/doi/full/10.1002/anie.201915678", "doi:10.1002/anie.201915678"],
    ["https://www.tandfonline.com/doi/abs/10.1080/00031305.2016.1154108", "doi:10.1080/00031305.2016.1154108"],
    ["https://dl.acm.org/doi/10.1145/3290605.3300234", "doi:10.1145/3290605.3300234"],
    ["https://journals.sagepub.com/doi/pdf/10.1177/0956797611417632", "doi:10.1177/0956797611417632"],
    ["https://link.springer.com/article/10.1007/s11263-015-0816-y", "doi:10.1007/s11263-015-0816-y"],
    ["https://www.nature.com/articles/nature14539", "doi:10.1038/nature14539"],
    ["https://www.jstor.org/stable/2280232", "doi:10.2307/2280232"],
    ["https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0185809", "doi:10.1371/journal.pone.0185809"],
    ["https://www.researchgate.net/publication/356580879_Tabular_data_Deep_learning_is_not_all_you_need", "title:Tabular data Deep learning is not all you need"],
    ["https://www.semanticscholar.org/paper/Attention-is-All-you-Need-Vaswani-Shazeer/204e3073870fae3d05bcbc2f6a8e263d9b72e776", "s2:204e3073870fae3d05bcbc2f6a8e263d9b72e776"],
    ["https://pubmed.ncbi.nlm.nih.gov/31452104/", "pmid:31452104"],
    ["https://pmc.ncbi.nlm.nih.gov/articles/PMC7096777/", "pmcid:PMC7096777"],
    ["https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7096777/", "pmcid:PMC7096777"],
    ["https://europepmc.org/article/MED/31452104", "pmid:31452104"],
    ["https://arxiv.org/abs/1706.03762v7", "arxiv:1706.03762"],
    ["https://ieeexplore.ieee.org/document/7780459", "ieee:7780459"],
    ["https://en.wikipedia.org/wiki/Photosynthesis", null],
    ["https://www.nature.com/subjects/biology", null],
  ];
  for (const [u, want] of ids) {
    const got = identify(u);
    assert.equal(got && `${got.kind}:${got.value}`, want, u);
  }
  assert.equal(doiIn('<meta name="citation_doi" content="10.1109/CVPR.2016.90">'), "10.1109/CVPR.2016.90");
  assert.equal(doiIn('<meta name="dc.identifier" content="doi:10.1016/j.cell.2020.01.001">'), "10.1016/j.cell.2020.01.001");
  assert.equal(doiIn('xplGlobal.document.metadata={"doi":"10.1109/5.771073","title":"x"}'), "10.1109/5.771073");
  assert.equal(doiIn("<p>no identifier here</p>"), null);
  assert.deepEqual(scholarKind("https://scholar.google.com/scholar?q=photosynthesis+light+reactions"), { kind: "search", q: "photosynthesis light reactions" });
  assert.equal(scholarKind("https://scholar.google.com/scholar?cites=1335834937404601091")?.kind, "cites");
  assert.equal(scholarKind("https://scholar.google.co.uk/citations?user=JicYPdAAAAAJ")?.kind, "profile");
  assert.equal(scholarKind("https://www.google.com/search?q=x"), null);

  // Title matching. A ResearchGate slug drops only punctuation (1.0); a truncated slug or a near title stays under the 0.95 bar.
  assert.equal(titleSimilarity("Tabular data Deep learning is not all you need", "Tabular data: Deep learning is not all you need"), 1);
  assert.ok(titleSimilarity("Deep Learning in Neural Networks An", "Deep learning in neural networks: An overview") < 0.95, "truncated slug");
  assert.ok(titleSimilarity("Draft: Deep Learning in Neural Networks: An Overview", "Deep learning in neural networks: An overview") < 0.95, "near title");
  const c = (title: string, doi: string | null, year: number, firstAuthor: string) => ({ title, doi, year, firstAuthor });
  // A preprint and its journal version are one paper: the journal DOI wins.
  assert.deepEqual(pickByTitle("Tabular data Deep learning is not all you need", [c("Tabular Data: Deep Learning is Not All You Need", "https://doi.org/10.48550/arxiv.2106.03253", 2021, "Ravid Shwartz-Ziv"), c("Tabular data: Deep learning is not all you need", "https://doi.org/10.1016/j.inffus.2021.11.011", 2021, "Ravid Shwartz-Ziv")]), { pick: c("Tabular data: Deep learning is not all you need", "https://doi.org/10.1016/j.inffus.2021.11.011", 2021, "Ravid Shwartz-Ziv") });
  // Two different works with the same title (seen live): no guess.
  assert.deepEqual(pickByTitle("Deep Learning in Neural Networks An Overview", [c("Deep learning in neural networks: An overview", "https://doi.org/10.1016/j.neunet.2014.09.003", 2014, "Jürgen Schmidhuber"), c("Deep Learning in Neural Networks: An Overview", "https://doi.org/10.1201/9781003277224-2", 2022, "Vidit Shukla")]), { none: "ambiguous" });
  assert.deepEqual(pickByTitle("Deep learning", [c("Deep learning", "https://doi.org/10.1038/nature14539", 2015, "Yann LeCun")]), { none: "short" });
  assert.deepEqual(pickByTitle("Deep Learning in Neural Networks An", [c("Deep learning in neural networks: An overview", "x", 2014, "Jürgen Schmidhuber")]), { none: "nomatch" });

  // OpenAlex abstracts are word -> positions.
  assert.equal(rebuildAbstract({ Plants: [0], light: [2, 5], use: [1], to: [3], make: [4] }), "Plants use light to make light");
  assert.equal(rebuildAbstract(null), "");

  // Open copies: HTML before PDF, published before preprint, arXiv as its HTML and PDF, PMC as its page, DOAJ records skipped.
  const copies = copiesOf([
    { is_oa: false, landing_page_url: "https://doi.org/10.1016/j.x" },
    { is_oa: true, landing_page_url: "https://doi.org/10.48550/arxiv.2106.03253", version: "submittedVersion" },
    { is_oa: true, landing_page_url: "https://doaj.org/article/abc" },
    { is_oa: true, landing_page_url: "https://europepmc.org/article/PMC/PMC123456", pdf_url: null, version: "publishedVersion" },
    { is_oa: true, landing_page_url: "https://repo.example.edu/item/9", pdf_url: "https://repo.example.edu/item/9.pdf", version: "acceptedVersion", source: { display_name: "Example Repository" } },
  ]);
  assert.deepEqual(copies.map((x) => `${x.kind} ${x.repo} ${x.version} ${x.url}`), [
    "html PubMed Central published https://pmc.ncbi.nlm.nih.gov/articles/PMC123456/",
    "html Example Repository accepted https://repo.example.edu/item/9",
    "html arXiv preprint https://arxiv.org/html/2106.03253",
    "pdf Example Repository accepted https://repo.example.edu/item/9.pdf",
    "pdf arXiv preprint https://arxiv.org/pdf/2106.03253",
  ]);

  // A stored work that names only a HAL record page gains the file; one that already has it, or has no HAL record, is unchanged.
  const halRec = { url: "https://hal.science/hal-04206682", kind: "html" as const, repo: "HAL", version: "preprint" as const };
  assert.deepEqual(withHalFile([halRec]).map((x) => `${x.kind} ${x.url}`), ["html https://hal.science/hal-04206682", "pdf https://hal.science/hal-04206682/document"]);
  assert.equal(withHalFile(withHalFile([halRec])).length, 2);
  assert.equal(withHalFile(copies).length, copies.length);

  // PubMed E-utilities XML (shape of efetch db=pubmed retmode=xml).
  const pm = parsePubmed(`<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><Article><Journal><JournalIssue><PubDate><Year>2019</Year></PubDate></JournalIssue><Title>Methods in molecular biology</Title></Journal><ArticleTitle>Molegro Virtual Docker for Docking.</ArticleTitle><Abstract><AbstractText Label="BACKGROUND">First part.</AbstractText><AbstractText>Second part.</AbstractText></Abstract><AuthorList><Author><LastName>Bitencourt-Ferreira</LastName><ForeName>Gabriela</ForeName></Author></AuthorList></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.1007/978-1-4939-9752-7_10</ArticleId><ArticleId IdType="pmc">PMC111</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>`);
  assert.equal(pm?.abstract, "BACKGROUND: First part.\n\nSecond part.");
  assert.deepEqual(pm?.authors, ["Gabriela Bitencourt-Ferreira"]);
  assert.equal(pm?.copies?.[0]?.url, "https://pmc.ncbi.nlm.nih.gov/articles/PMC111/");

  // Paywall detection on saved snippets (publisher wording as served; a full article never prints these).
  assert.ok(paywalled('<div class="c-article-access">Access through your institution</div><a>Buy or subscribe</a>', 2400), "Nature");
  assert.ok(paywalled('<a class="link-button">Purchase PDF</a><span>Get full access to this article</span>', 3100), "ScienceDirect");
  assert.ok(paywalled("<h2>Access options</h2><p>Instant access to the full article PDF.</p>", 1800), "Springer");
  assert.ok(paywalled("<div>Log in via an institution</div><div>Buy this article</div>", 2000), "Taylor & Francis");
  assert.ok(!paywalled("<h2>Abstract</h2><p>Open text.</p>", 2000), "open abstract page");
  assert.ok(!paywalled("<span>Access through your institution</span>", 45_000), "full text with a sign-in link in the header");

  // Reddit links
  assert.deepEqual(redditLink("https://old.reddit.com/r/learnmath/comments/167mgyz/what_exactly_is_a_derivative/?sort=top"), { kind: "thread", url: "https://www.reddit.com/r/learnmath/comments/167mgyz/what_exactly_is_a_derivative/", sub: "learnmath" });
  assert.equal(redditLink("https://www.reddit.com/r/askscience/")?.kind, "listing");
  assert.equal(redditLink("https://redd.it/167mgyz")?.kind, "thread");
  assert.equal(redditLink("https://www.reddit.com/user/someone/"), null);

  // Reddit's Atom feed for a thread (Reddit's documented shape; no live feed answered this machine, see the report).
  const feed = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><category term="learnmath" label="r/learnmath"/><title>What exactly is a derivative? : learnmath</title>
<entry><author><name>/u/student_a</name><uri>https://www.reddit.com/user/student_a</uri></author><category term="learnmath" label="r/learnmath"/><content type="html">&lt;!-- SC_OFF --&gt;&lt;div class="md"&gt;&lt;p&gt;Is a derivative the same as a slope?&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt; &amp;#32; submitted by &amp;#32; &lt;a href="https://www.reddit.com/user/student_a"&gt; /u/student_a &lt;/a&gt; &lt;br/&gt; &lt;span&gt;&lt;a href="https://www.reddit.com/r/learnmath/comments/167mgyz/x/"&gt;[link]&lt;/a&gt;&lt;/span&gt; &amp;#32; &lt;span&gt;&lt;a href="https://www.reddit.com/r/learnmath/comments/167mgyz/x/"&gt;[comments]&lt;/a&gt;&lt;/span&gt;</content><id>t3_167mgyz</id><link href="https://www.reddit.com/r/learnmath/comments/167mgyz/x/"/><title>What exactly is a derivative?</title></entry>
<entry><author><name>/u/helper_b</name></author><content type="html">&lt;div class="md"&gt;&lt;p&gt;It is the slope of the tangent line.&lt;/p&gt;&lt;p&gt;At one point.&lt;/p&gt;&lt;/div&gt;</content><id>t1_aaa</id><title>/u/helper_b on What exactly is a derivative?</title></entry>
<entry><author><name>/u/[deleted]</name></author><content type="html">&lt;div class="md"&gt;&lt;p&gt;[removed]&lt;/p&gt;&lt;/div&gt;</content><id>t1_bbb</id><title>removed</title></entry>
</feed>`;
  const post = parseThreadFeed(feed)!;
  assert.equal(post.title, "What exactly is a derivative?");
  assert.equal(post.author, "student_a");
  assert.equal(post.text, "Is a derivative the same as a slope?");
  assert.deepEqual(post.comments.map((x) => x.author), ["helper_b"], "removed comment skipped");
  const tw = threadTwin(post, "https://www.reddit.com/r/learnmath/comments/167mgyz/x/", "direct", "From Reddit's public feed.");
  assert.equal(tw.nodes[1].blocks?.[0].text, "From helper_b: It is the slope of the tangent line. At one point.");
  assert.equal(parseListingFeed(feed).length, 1);

  // One record of Bright Data's Reddit Posts dataset (shape from a live snapshot, names replaced).
  const scraped = fromScraper({
    title: "What exactly is a derivative?",
    user_posted: "student_a",
    description: "I'm new to calculus.",
    community_name: "learnmath",
    comments: [
      { comment: "Rate of change.", user_commenting: "helper_b", replies: [{ comment: "Yes, at a point.", user_commenting: "helper_c", replies: [{ comment: "Too deep, depth 2 is read.", user_commenting: "helper_d", replies: [{ comment: "depth 3 is not", user_commenting: "helper_e" }] }] }] },
      { comment: "[deleted]", user_commenting: "[deleted]" },
    ],
  })!;
  assert.deepEqual(scraped.comments.map((x) => `${x.depth} ${x.author}`), ["0 helper_b", "1 helper_c", "2 helper_d"]);
  assert.equal(threadTwin(scraped, "u", "cache", "c").nodes[1].blocks?.[1].text, "Reply from helper_c: Yes, at a point.");

  // 4. arXiv: abstract links, arXiv DOIs, old-style ids and versions name the paper; the full text wins over the abstract page.
  assert.deepEqual(identify("https://doi.org/10.48550/arXiv.1706.03762"), { kind: "arxiv", value: "1706.03762" });
  assert.deepEqual(identify("https://arxiv.org/abs/hep-th/9901001v2"), { kind: "arxiv", value: "hep-th/9901001" });
  const asked: string[] = [];
  const page = (n: number) => (u: string): Promise<Twin> => (asked.push(u), Promise.resolve({ id: "t", source: { url: u, kind: "page", title: "T", via: "direct" }, nodes: [{ id: "n01", kind: "section", order: 1, level: 2, heading: "H", text: "word ".repeat(n) }], counts: { sections: 1, figures: 0, segments: 0 } }));
  const full = await arxivLoad("https://arxiv.org/abs/2303.08774v3", "2303.08774", { page: page(900), pdf: page(900) });
  assert.deepEqual(asked, ["https://arxiv.org/html/2303.08774v3"], "HTML first, version kept");
  assert.equal(full.source.via, "open-copy");
  assert.match(full.nodes[0].text, /authors' preprint/);
  asked.length = 0;
  await arxivLoad("https://arxiv.org/abs/hep-th/9901001", "hep-th/9901001", { page: page(40), pdf: page(900) });
  assert.deepEqual(asked, ["https://arxiv.org/html/hep-th/9901001", "https://arxiv.org/pdf/hep-th/9901001"], "thin or missing HTML: the PDF");

  // 2. A record with no open location borrows its sibling's: same title, same first author, a year apart (ResNet, seen live).
  const rec = (title: string, doi: string, year: number, author: string, cites: number, oa?: string): OaWork => ({ src: "OpenAlex", title, doi, publication_year: year, cited_by_count: cites, authorships: [{ author: { display_name: author } }], locations: oa ? [{ is_oa: true, landing_page_url: oa, version: "submittedVersion" }] : [{ is_oa: false, landing_page_url: doi }] });
  const cvpr = rec("Deep Residual Learning for Image Recognition", "https://doi.org/10.1109/cvpr.2016.90", 2016, "Kaiming He", 290606);
  const arx = rec("Deep Residual Learning for Image Recognition", "https://doi.org/10.48550/arxiv.1512.03385", 2015, "Kaiming He", 18022, "https://arxiv.org/abs/1512.03385");
  const other = rec("Deep Residual Learning for Image Recognition", "https://doi.org/10.0/x", 2016, "Someone Else", 1, "https://repo.example.org/x");
  assert.deepEqual(siblingCopies(cvpr, [cvpr, arx, other]).map((x) => x.url), ["https://arxiv.org/html/1512.03385", "https://arxiv.org/pdf/1512.03385"], "only the same author's record");

  // 3. Several works with one title: up to five candidates, most cited first, each linked by its DOI; Arc never picks one.
  const many = [rec("Attention Is All You Need", "https://doi.org/10.1/a", 2023, "Some Author", 5), arx, rec("Attention is all you need", "https://doi.org/10.48550/arxiv.1706.03762", 2017, "Ashish Vaswani", 9000, "https://arxiv.org/abs/1706.03762"), rec("Attention Is All You Need In Speech Separation", "https://doi.org/10.1/b", 2021, "X Y", 300)];
  const strong = strongOf("Attention Is All You Need", many);
  assert.deepEqual(strong.map((x) => x.cited_by_count), [9000, 5], "strong title matches only, most cited first");
  const hits = hitsOf(strong, true);
  assert.equal(hits[0].url, "https://doi.org/10.48550/arxiv.1706.03762");
  assert.ok(hits[0].open && /Ashish Vaswani/.test(hits[0].snippet) && /2017/.test(hits[0].snippet));
  assert.equal(hits[1].open, false);

  // Round 3: a publisher page that is only a preview (Springer's U-Net chapter, as loaded) vs a full open article (PMC, as loaded).
  const pv = (sections: [string, number][]): Twin => ({ id: "t", source: { url: "u", kind: "page", title: "T", via: "direct" }, nodes: sections.map(([heading, n], i) => ({ id: `n0${i}`, kind: "section", order: i, level: 2, heading, text: "x".repeat(n) })), counts: { sections: sections.length, figures: 0, segments: 0 } });
  assert.ok(isPreview(pv([["Abstract", 1130], ["Editor information: Editors and Affiliations", 336], ["Copyright information", 52], ["About this paper: Cite this paper", 364], ["Keywords", 157], ["Publish with us", 19]])), "Springer chapter preview");
  assert.ok(!isPreview(pv([["Abstract", 1706], ["COVID-19 cases in EU/EEA countries and the UK", 852], ["Obtaining cumulative number", 848], ["Trends of COVID-19", 924], ["Discussion", 3533]])), "PMC full article");
  assert.ok(!isPreview(pv([["Introduction", 2500]])), "a short full article stays");

  // Round 4: an index that is throttled or down has not answered; the fallbacks answer instead; the sign-in line needs an answer.
  type Route = (u: string) => Response | "timeout";
  const serve = (route: Route) =>
    setTransport(async (u, init) => {
      const r = route(u);
      if (r === "timeout") return new Promise<Response>((_, no) => init.signal.addEventListener("abort", () => no(new Error("timeout")), { once: true }));
      return r;
    });
  const J = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { "content-type": "application/json" } });
  const busy = () => new Response("", { status: 429, headers: { "retry-after": "0" } });
  const hallmarksCrossref = { message: { DOI: "10.1016/j.cell.2013.05.039", title: ["The Hallmarks of Aging"], author: [{ given: "Carlos", family: "López-Otín" }], "container-title": ["Cell"], issued: { "date-parts": [[2013]] } } };
  const hallmarksEpmc = { resultList: { result: [{ title: "The hallmarks of aging.", doi: "10.1016/j.cell.2013.05.039", pmid: "23746838", pmcid: "PMC3836174", inPMC: "Y", isOpenAccess: "N", authorString: "López-Otín C, Blasco MA.", journalTitle: "Cell", pubYear: "2013", abstractText: "Aging is characterized by..." }] } };
  const doi = { kind: "doi" as const, value: "10.1016/j.cell.2013.05.039" };
  const sig = () => AbortSignal.timeout(8000);
  const alive = setInterval(() => {}, 500); // AbortSignal.timeout timers do not hold the process open while a fake timeout waits
  try {
    // OpenAlex throttled: Crossref finds the work, Europe PMC finds the PubMed Central copy.
    serve((u) => (/openalex/.test(u) ? busy() : /crossref/.test(u) ? J(hallmarksCrossref) : /europepmc/.test(u) ? J(hallmarksEpmc) : /semanticscholar/.test(u) ? busy() : new Response("<feed/>", { status: 200 })));
    let r = await resolve(doi, sig());
    assert.equal(r.work?.title, "The Hallmarks of Aging");
    assert.equal(r.work?.copies[0]?.url, "https://pmc.ncbi.nlm.nih.gov/articles/PMC3836174/", "PMC copy through Europe PMC");
    assert.equal(r.work?.checked, true);
    // OpenAlex throttled and Europe PMC timing out and Semantic Scholar throttled: details from Crossref, but nothing checked.
    serve((u) => (/openalex|semanticscholar/.test(u) ? busy() : /crossref/.test(u) ? J(hallmarksCrossref) : /europepmc/.test(u) ? "timeout" : new Response("<feed/>", { status: 200 })));
    r = await resolve(doi, AbortSignal.timeout(4000));
    assert.equal(r.work?.checked, false, "no open-access source answered");
    assert.equal(r.work?.copies.length, 0);
    const twin = metadataTwin(r.work!, "https://www.sciencedirect.com/science/article/pii/S0092867413006454");
    assert.match(twin.nodes[0].text, /could not check for a free copy/);
    assert.doesNotMatch(twin.nodes[0].text, /sign-in/);
    assert.ok(!keptFresh({ ...r.work!, at: Date.now() }), "an unchecked answer is never kept");
    // An open-access source answered and lists no copy: now the sign-in line is justified, and it is kept for a day only.
    serve((u) => (/openalex/.test(u) ? J({ title: "Closed paper", doi: "https://doi.org/10.1/closed", publication_year: 2019, authorships: [{ author: { display_name: "A Writer" } }], locations: [{ is_oa: false, landing_page_url: "https://doi.org/10.1/closed" }] }) : /europepmc/.test(u) ? J({ resultList: { result: [] } }) : /semanticscholar/.test(u) ? new Response("", { status: 404 }) : new Response("<feed/>", { status: 200 })));
    r = await resolve({ kind: "doi", value: "10.1/closed" }, sig());
    assert.equal(r.work?.checked, true);
    assert.match(metadataTwin(r.work!, "https://example.org/x").nodes[0].text, /sign-in/);
    assert.ok(keptFresh({ ...r.work!, at: Date.now() - 3_600_000 }) && !keptFresh({ ...r.work!, at: Date.now() - 2 * 86_400_000 }), "a closed answer expires after a day");
    // A paywalled id when Crossref does not answer: "could not check", not "no such paper".
    serve(() => busy());
    assert.equal((await resolve({ kind: "pii", value: "S0092867413006454" }, AbortSignal.timeout(4000))).why, "unchecked");
    // Search: OpenAlex throttled, Crossref answers; its results make no claim about a free copy, and keep author and year.
    serve((u) => (/openalex/.test(u) ? busy() : /crossref/.test(u) ? J({ message: { items: [hallmarksCrossref.message] } }) : J({ resultList: { result: [] } })));
    const found = await searchWorks("hallmarks of aging", sig());
    assert.equal(found[0]?.title, "The Hallmarks of Aging");
    assert.equal(found[0]?.open, undefined);
    assert.doesNotMatch(found[0].snippet, /Not open|Open copy/);
    assert.match(found[0].snippet, /Carlos López-Otín\. Cell, 2013/);
  } finally {
    setTransport(null);
    clearInterval(alive);
  }
  // arXiv's API: a match needs the title at the bar and the same first author.
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/1505.04597v1</id><title>U-Net: Convolutional Networks for Biomedical
 Image Segmentation</title><author><name>Olaf Ronneberger</name></author></entry></feed>`;
  assert.equal(arxivMatch(atom, "U-Net: Convolutional Networks for Biomedical Image Segmentation", "ronneberger"), "1505.04597");
  assert.equal(arxivMatch(atom, "U-Net: Convolutional Networks for Biomedical Image Segmentation", "fischer"), null);

  // A title matched only by a fallback index (OpenAlex silent) is offered as a candidate, never opened: Crossref has an unrelated
  // "Attention is all you need" and no record of the NeurIPS paper (seen live).
  setTransport(async (u) => (/openalex/.test(u) ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : /crossref/.test(u) ? new Response(JSON.stringify({ message: { items: [{ DOI: "10.9/other", title: ["Attention is all you need"], author: [{ given: "Some", family: "One" }], issued: { "date-parts": [[2021]] } }] } }), { status: 200 }) : new Response("", { status: 404 })));
  try {
    const t = await resolve({ kind: "title", value: "Attention Is All You Need" }, AbortSignal.timeout(6000));
    assert.equal(t.work, null);
    assert.equal(t.why, "ambiguous");
    assert.equal(t.partial, "exact");
    assert.equal(t.candidates?.length, 1);
  } finally {
    setTransport(null);
  }
  // PubMed Central JATS (E-utilities efetch db=pmc), the route when PMC's page challenges.
  const jats = parseJats(`<pmc-articleset><article><front><article-meta><title-group><article-title>The Hallmarks of Aging</article-title></title-group><abstract><p>Aging is characterized by loss.</p></abstract></article-meta></front><body><sec><title>Introduction</title><p>First paragraph.</p><fig><label>Figure 1</label><caption><p>The hallmarks.</p></caption></fig><sec><title>Genomic Instability</title><p>Nested.</p></sec></sec></body></article></pmc-articleset>`, "https://pmc.ncbi.nlm.nih.gov/articles/PMC3836174/")!;
  assert.deepEqual(jats.nodes.map((n) => `${n.level} ${n.heading}: ${n.text}`), ["2 Abstract: Aging is characterized by loss.", "2 Introduction: First paragraph.\n\nFigure 1 The hallmarks.", "3 Genomic Instability: Nested."]);

  // Round 5. 1: Elsevier article ids with punctuation on Cell Press, The Lancet and Elsevier's link hub.
  assert.deepEqual(identify("https://www.cell.com/cell/fulltext/S0092-8674(14)00604-7"), { kind: "pii", value: "S0092867414006047" });
  assert.deepEqual(identify("https://www.cell.com/cell/pdf/S0092-8674(14)00604-7.pdf"), { kind: "pii", value: "S0092867414006047" });
  assert.deepEqual(identify("https://www.thelancet.com/journals/lancet/article/PIIS0140-6736(20)30183-5/fulltext"), { kind: "pii", value: "S0140673620301835" });
  assert.deepEqual(identify("https://www.thelancet.com/journals/lancet/article/S0140-6736(20)30183-5/fulltext"), { kind: "pii", value: "S0140673620301835" });
  assert.deepEqual(identify("https://linkinghub.elsevier.com/retrieve/pii/S0092867413006454"), { kind: "pii", value: "S0092867413006454" });
  // 2: author names from any index, safe to speak.
  assert.equal(cleanName("gurvir.virdi not provided"), null);
  assert.equal(cleanName("Anonymous"), null);
  assert.equal(cleanName("someone@example.org"), null);
  assert.equal(cleanName("Carlos López-Otín"), "Carlos López-Otín");
  assert.equal(cleanName("Geoffrey E. Hinton"), "Geoffrey E. Hinton");
  assert.equal(cleanName("Achiam, Josh"), "Josh Achiam");
  assert.equal(cleanName("mineechoi"), null);
  assert.equal(cleanName("OpenAI"), "OpenAI");
  // 3: adjacent elements of a result keep a space between them.
  assert.equal(spacedText("<span>Chapter Summary</span><span>8.1</span>Overview of <b>Photosynthesis</b> The&nbsp;process"), "Chapter Summary 8.1 Overview of Photosynthesis The process");
  // 4: only a search that asks for research goes to the paper index first.
  for (const q of ["photosynthesis openstax biology", "organic chemistry", "cell division biology"]) assert.ok(!scholarly(q), q);
  for (const q of ["attention is all you need paper", "Vaswani 2017 transformers", "review of mitochondria membrane potential", "10.1016/j.cell.2013.05.039"]) assert.ok(scholarly(q), q);
  // 6: the Details block: first three authors in full, then the count; year, venue, DOI; which version a copy is.
  assert.equal(names(["Yann LeCun", "Yoshua Bengio", "Geoffrey E. Hinton"]), "Yann LeCun, Yoshua Bengio and Geoffrey E. Hinton");
  assert.equal(detailsText({ authors: ["Carlos López-Otín", "Maria A. Blasco", "Linda Partridge", "Manuel Serrano", "Guido Kroemer"], year: 2013, venue: "Cell", doi: "10.1016/j.cell.2013.05.039" }, { url: "u", kind: "html", repo: "PubMed Central", version: "accepted" }),
    "By Carlos López-Otín, Maria A. Blasco, Linda Partridge and 2 others. Cell, 2013. DOI 10.1016/j.cell.2013.05.039. This copy is the authors' accepted manuscript.");
  const noted = withNote({ id: "t", source: { url: "u", kind: "page", title: "T", via: "direct", credit: "Full text from PubMed Central through NCBI E-utilities." }, nodes: [{ id: "n01", kind: "section", order: 1, level: 2, heading: "Abstract", text: "x" }], counts: { sections: 1, figures: 0, segments: 0 } }, "This is the free copy from PubMed Central: the authors' accepted manuscript, not the journal's final layout.", "c", { authors: ["A B"], year: 2013, venue: "Cell", doi: "10.1/x" });
  assert.deepEqual(noted.nodes.map((n) => n.heading), ["About this copy", "Details", "Abstract"]);
  assert.match(noted.nodes[0].text, /^This is the free copy from PubMed Central: the authors' accepted manuscript[^.]*\. The figures are not included in this copy\.$/);
  // 7: the same title means the same words in the same order; arXiv entries carry their arXiv DOI.
  assert.ok(sameTitle("Attention Is All You Need", "Attention is all you need."));
  assert.ok(!sameTitle("Attention Is All You Need", "Is Attention All You Need?"));
  const ax = arxivEntries(`<feed><entry><id>http://arxiv.org/abs/1706.03762v7</id><published>2017-06-12T17:57:34Z</published><title>Attention Is All
 You Need</title><author><name>Ashish Vaswani</name></author></entry></feed>`);
  assert.equal(ax[0].doi, "https://doi.org/10.48550/arXiv.1706.03762");
  assert.equal(ax[0].publication_year, 2017);
}
