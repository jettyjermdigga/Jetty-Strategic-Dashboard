# Weekly notes

One file per week: `notes/<year>/wk<NN>.md`. The build reads them and puts a
clickable 1–52 strip above Total Revenue on the Summary tab. A week with no
file still appears in the strip, greyed, and says so when you click it.

The renderer takes a deliberately small slice of Markdown, because a note is
read far more often than it is written and a surprise in the formatting costs
more than the feature it would have added:

    ## Heading
    A paragraph. Blank lines separate paragraphs.
    - A bullet
    | Column | Column |
    |---|---|
    | cell   | cell   |
    **bold** and *italic* inline.

Sections are named after the dashboard's own tabs -- Summary, Revenue, COGS &
Shipping, Inventory, Labor, OpEx, Cash Flow -- so a note can be read beside the
tab it is about. A tab with nothing worth saying is left out rather than padded.

Anything else is shown as written. HTML in a note is escaped, not rendered.

## Who writes it

A scheduled task ("Weekly dashboard commentary") runs every Monday at 7:38am
Eastern and drafts the note for the week the dashboard currently reports, if
there isn't one yet. It reads its figures from `facts.json` on the `gh-pages`
branch — which the build publishes for exactly this purpose — and never from
the workbook.

It drafts and stops. The note is Jeremy's commentary, so the draft lands on a
branch for him to read and edit; nothing reaches `main` without him. An
existing note is never rewritten.

Remember that the dashboard only picks up a note on its **next rebuild**,
which happens when the workbook is saved, or by running the *Update Jetty
Dashboard* workflow with `force`.
