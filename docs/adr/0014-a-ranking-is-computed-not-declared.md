# A ranking is computed, not declared

The DiscoverTab existed as `DiscoverService` and an interface with no
implementation behind it, and nothing in the application constructed either. What
the service was handed described the answer rather than the evidence for it:
`getTrending()` received `[{ templateId, lift }]` and sorted it, so "trending this
week" was whatever the caller had decided to put in the list, and there was no
point between the database and the screen at which anything had been counted.
`getRecommendations()` walked User Topics, their Sources and the Directory entries
three deep and added one for every pair that matched, which meant an entry scored
two for one User Topic whenever it shared two of that Topic's Sources, and scored
again for every other Topic following the same outlet. `getDirectory()` filtered
the Directory against `userTopicIds` — a set of the User's **Topic** ids, compared
against **TopicTemplate** ids, both randomly generated — so "entries you have not
subscribed to" excluded nothing at all. And `canCloneTopic()` was a predicate: it
answered whether a clone could happen and cloned nothing, while the one code path
that did clone was `selectTopics`, which refuses anything that is not exactly
three.

Two of the three ideas on the page were therefore not computed from anything. The
third — "topics like yours" — was the one CONTEXT.md defines as derived from "the
User's existing Topics' Entity and Source overlap", and the Entity half of that
sentence had never been implemented at all, so two entries about the same company
from different outlets scored zero against a User who followed one of them.

The decision is that the split between measuring and ranking runs the way the
names suggest, and cannot be arranged the other way round:

- **`DiscoverRepo` measures; `DiscoverService` ranks.** Three methods, and none of
  them returns an ordering: the Directory with the Entities its Sources have
  mentioned in the window, the User's live Topics with theirs, and how many
  Articles each Source published. A repository that cannot express an opinion is
  what makes it impossible for a caller to hand the service a ranking and call it a
  feature. The old interface's `getTrendingTemplateIds(): Promise<{ lift: number }[]>`
  is the shape this replaces, and the reason it was never implemented is now
  visible: there was nothing behind it to implement against.
- **One window, named on the page.** `DISCOVER_WINDOW_DAYS = 7`, applied to all
  three measurements, and printed next to the trending heading. The previous code
  had a "this week" label and no period behind it, and a period nobody can name is
  a period nobody can check the numbers against. One constant rather than three
  windows, because a page showing overlap measured over seven days beside trending
  measured over thirty would be making two claims about the same corpus. The window
  is bounded at **both** ends: `published_at >= start AND < end`, with the end read
  off the injected clock. A feed that mislabels an archive, or a clock that was
  wrong when the row was written, otherwise leaves that Article counting towards
  "this week" for as long as the database keeps it.
- **Overlap is counted as sets, not as pairs.** A Recommendation scores one point
  per distinct Source shared and one per distinct Entity shared. Sets are the only
  version of "how much is shared" that cannot be inflated by being broad, and the
  Entity is the half that was missing: an Entity is one named thing, while
  a Source is an outlet that writes about everything, which is why the page names
  the two counts separately instead of printing one score.
- **"Already subscribed to" is read from the origin, and from the title.**
  `topics.origin_template_id` names the Directory entry a Topic was cloned from,
  and that is the identifier the Directory filters on. `titleKey` is applied as
  well, because the clone path refuses on a folded title too, and a Directory that
  only knew about template ids would offer a card the clone then refuses. Note
  that the seed writes `topic_templates.id === slug` and a clone takes that slug,
  so the two identifier spaces collide by coincidence often enough to look like a
  working rule; the coincidence is not the rule, and `discover-service.test.ts`
  pins a case where a Topic id equals a template id and the entry is still offered.
- **One entry at a time.** `POST /discover/add` clones a single template through
  `OnboardingService.addTopics`, which already enforces the tier cap, slug
  allocation and the already-held check. The exactly-three rule belongs to
  `selectTopics`, and it is a rule about a checkbox form being filled in — it is
  not a statement about what a User is allowed to end up holding. A refusal comes
  back as the DiscoverTab with the reason in words and 402 for the cap, so a User
  keeps the Directory they were reading and the way to act on what they are told.

The cost is joins. One request is seven statements — the Directory and its Source
links, the entity pairs for the Directory, a User's Topics, their Source links,
their entity pairs, the per-Source volume, and the User's Topics again inside the
scoped entity join — and that count does not move with the size of the Directory.
The two entity joins are `topic_template_sources → articles → article_entities` and
`topic_sources → articles → article_entities`, each grouped by its owner so a pair
repeated across ten Articles of one story collapses to one. Asking per entry is the
same join a few hundred times over, and that is the shape the acceptance criterion
is really about. `discover/routes.test.ts` asserts the whole page renders in under
a second at more than two hundred entries, with four hundred Articles in the window
so both joins actually execute.

Related: [[0003-registry-ingest-tick-driven]], which is why Article volume is the
one thing in the corpus that can be counted without a new table, and
[[0009-one-design-token-layer-and-one-document-shell]], which is why this is a
navigation item on every page rather than a screen a User has to find.