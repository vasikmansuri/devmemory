# Retrieval evaluation

Run it with `npm run eval` (source: `test/eval/`). The corpus is 46 memories from a fictional e-commerce project. There are 36 labelled queries: 28 **direct** (they share words with the target memory) and 8 **paraphrase** (little or no shared vocabulary).

## Measured results

DevMemory 0.1.0, Node 26.10, macOS:

| Retriever     | Query set      | Recall@5  | Precision@5 | MRR       |
| ------------- | -------------- | --------- | ----------- | --------- |
| FTS5 + BM25   | all (36)       | **0.944** | 0.217       | **0.922** |
| FTS5 + BM25   | direct (28)    | 1.000     | 0.229       | 1.000     |
| FTS5 + BM25   | paraphrase (8) | 0.750     | 0.175       | 0.650     |
| LIKE fallback | all (36)       | 0.944     | 0.217       | 0.881     |

**Why Precision@5 looks low:** most queries have only one relevant memory, so the best possible Precision@5 on this set is **0.228**. The measured 0.217 is close to that ceiling.

**What was missed:** both misses are paraphrases with no shared vocabulary:

- "which SQL engine backs the app" (the memory says "PostgreSQL… database");
- "who gets woken up when checkout breaks" (the memory says "PagerDuty pages the on-call engineer").

Closing this gap needs semantic retrieval, which is planned but not implemented.

## Caveats

- The same author wrote the corpus and the queries, so the direct-query numbers are likely optimistic.
- The corpus is small, and real projects will score differently.
- The tests fail the build if direct Recall@5 drops below 0.9, overall Recall@5 below 0.75, or MRR below 0.7.
