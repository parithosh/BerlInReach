#!/usr/bin/env python3
"""Render site/index.html from templates/index.html, with the figures computed by build_data.py (data/stats.json)."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime
from html import escape, unescape
from pathlib import Path
from string import Template

ROOT = Path(__file__).resolve().parent
SITE = ROOT / "site"

MODES = ["ubahn", "sbahn", "tram", "regional", "bus", "ferry"]
MODE_LABELS = {"ubahn": "U-Bahn", "sbahn": "S-Bahn", "tram": "Tram", "regional": "Regional train", "bus": "Bus", "ferry": "Ferry"}
MODE_PLURALS = {"ubahn": "U-Bahn lines", "sbahn": "S-Bahn lines", "tram": "Tram lines", "regional": "Regional trains", "bus": "Bus lines", "ferry": "Ferries"}
MODE_DOTS = {"ubahn": "#115D91", "sbahn": "#008D4F", "tram": "#BE1414", "regional": "#E2001A", "bus": "#A5027D", "ferry": "#0080BA"}
RAIL_MODES = {"ubahn", "sbahn", "tram", "regional"}


def version(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:8]


def long_date(value: str) -> str:
    day = date.fromisoformat(value[:10])
    return f"{day.strftime('%A')} {day.day} {day.strftime('%B %Y')}"


def short_date(value: str) -> str:
    day = date.fromisoformat(value[:10])
    return f"{day.day} {day.strftime('%B %Y')}"


def number(value: float) -> str:
    return f"{value:,.1f}".rstrip("0").rstrip(".") if isinstance(value, float) else f"{value:,}"


def badge(line: dict) -> str:
    return f'<span class="line-badge" style="background:{line["color"]};color:{line["text"]}">{escape(line["name"])}</span>'


def line_label(line: dict) -> str:
    return line["name"] if line["mode"] in ("ubahn", "sbahn", "regional") else f"{MODE_LABELS[line['mode']]} {line['name']}"


def mode_toggles() -> str:
    rows = []
    for mode in MODES:
        rows.append(
            f'            <label class="pill-toggle"><input type="checkbox" value="{mode}" checked />'
            f'<span class="mode-dot" style="background:{MODE_DOTS[mode]}"></span> {MODE_LABELS[mode]}</label>'
        )
    return "\n".join(rows)


def stat_cards(stats: dict, lines: list) -> str:
    top = stats["frequent"][0] if stats["frequent"] else None
    by_mode = stats["stationsByMode"]
    cards = [
        (f'{stats["within30"]}%', f'of U-Bahn, S-Bahn, tram and train stations within 30 min of the centre ({escape(stats["center"])})'),
        (number(stats["railStations"]), f'rail stations, {by_mode["ubahn"]} of them on the U-Bahn, {by_mode["sbahn"]} on the S-Bahn and {by_mode["tram"]} on the tram'),
    ]
    if top:
        line = lines[top["line"]]
        cards.append((f'{number(top["headway"])}&nbsp;min', f'between two departures on {escape(line_label(line))} at rush hour, the most frequent line'))
    cards.append((f'{stats["farthestMinutes"]}&nbsp;min', f'from the centre to {escape(stats["farthestStation"])}, the farthest rail station'))
    return "\n".join(f'          <div class="stat"><strong>{value}</strong><span>{text}</span></div>' for value, text in cards)


def line_tables(stats: dict) -> str:
    blocks = []
    for mode in ["ubahn", "sbahn", "tram", "regional", "ferry"]:
        rows = [line for line in stats["lines"] if line["mode"] == mode]
        if not rows:
            continue
        body = "\n".join(
            f'            <tr><td>{badge(line)}</td><td>{line["stations"]}</td>'
            f'<td>{"~" + number(line["headway"]) + " min" if line["headway"] else "—"}</td></tr>'
            for line in rows
        )
        blocks.append(
            f"""        <details class="lines-block"{' open' if mode in ('ubahn', 'sbahn') else ''}>
          <summary>{MODE_PLURALS[mode]} <span class="muted">· {len(rows)}</span></summary>
          <table class="lines-table">
            <thead><tr><th scope="col">Line</th><th scope="col">Stations in Berlin</th><th scope="col">One every</th></tr></thead>
            <tbody>
{body}
            </tbody>
          </table>
        </details>"""
        )
    trips = stats["tripsPerMode"]
    volume = ", ".join(f"{number(trips[mode])} {MODE_LABELS[mode]}" for mode in MODES if trips.get(mode))
    caption = (
        f'        <p class="muted">Weekday daytime (7:00–20:00) headways, median over the line\'s stops, on {long_date(stats["referenceDate"])}. '
        f"Trips that day in the Berlin area: {volume}; plus {stats['linesByMode'].get('bus', 0)} bus lines.</p>"
    )
    return "\n".join([caption, *blocks])


def ranking_cards(stats: dict, lines: list) -> str:
    def card(title: str, items: list[str], note: str) -> str:
        entries = "\n".join(f"              <li>{item}</li>" for item in items)
        return (
            f'          <div class="ranking-card">\n            <span class="ranking-card-question">{title}</span>\n'
            f"            <ol>\n{entries}\n            </ol>\n            <span class=\"muted\">{note}</span>\n          </div>"
        )

    def rank(i: int) -> str:
        return f'<span class="rank">{i + 1:02d}</span>'

    frequent = [
        f'{rank(i)} {badge(lines[item["line"]])} every <strong>{number(item["headway"])} min</strong>'
        for i, item in enumerate(stats["frequent"][:5])
    ]
    busiest = [
        f'{rank(i)} <strong>{escape(item["station"])}</strong> · {number(item["departures"])} departures'
        for i, item in enumerate(stats["busiest"][:5])
    ]
    longest = [
        f'{rank(i)} {badge(lines[item["line"]])} <strong>{item["minutes"]} min</strong> · {escape(item["from"])} → {escape(item["to"])}'
        for i, item in enumerate(stats["longest"][:5])
    ]
    return "\n".join(
        [
            card("Which line runs most often?", frequent, "U-Bahn, S-Bahn, tram and trains, 7:00–9:00, busiest stop and direction."),
            card("Which station is the busiest?", busiest, "Rail departures (U, S, tram, regional) over the whole weekday."),
            card("Which ride is the longest?", longest, "Scheduled time from end to end, U-Bahn, S-Bahn and tram, within the map area."),
        ]
    )


def faq_entries(config: dict, stats: dict, lines: list) -> list[tuple[str, str]]:
    """(question, answer as HTML)."""
    name = config["name"]
    rail_rows = [line for line in stats["lines"] if line["mode"] in ("ubahn", "sbahn") and line["headway"]]
    headways = ", ".join(f'{line["name"]}: {number(line["headway"])} min' for line in rail_rows)
    top = stats["frequent"][0] if stats["frequent"] else None
    top_text = f" The most frequent at rush hour is {line_label(lines[top['line']])}, every {number(top['headway'])} minutes." if top else ""
    period = stats["servicePeriod"]
    plain = [
        (
            f"How long does it take to cross {name} by public transport?",
            f'From the centre ({stats["center"]}), {stats["within15"]}% of U-Bahn, S-Bahn, tram and train stations are less '
            f'than 15 minutes away and {stats["within30"]}% less than 30 minutes, walking and waiting included. '
            f'The farthest one, {stats["farthestStation"]}, takes about {stats["farthestMinutes"]} minutes.',
        ),
        (
            "How often do the U-Bahn and S-Bahn run?",
            f"On a weekday between 7:00 and 20:00, the typical gap between two trains is {headways}.{top_text}",
        ),
        (
            "Where do the timetables come from?",
            f'From the official {config["network"]} timetable in GTFS format ({config["gtfsAttribution"]}, {config["gtfsLicence"]}), '
            f'downloaded on {short_date(stats["gtfsFetchedAt"])} and valid until {short_date(period[1])}. Times are those of '
            f'{long_date(stats["referenceDate"])}, between 7:00 and 20:00.',
        ),
        (
            "Which modes of transport are included?",
            "All of them: U-Bahn, S-Bahn, tram, regional trains (RE, RB, FEX), buses and BVG ferries. Untick a mode under the "
            "map to see the city without it — for example only the rail network, or everything but buses.",
        ),
        (
            "What do Day, Rush hour and Night mean?",
            f"Three slices of the same weekday timetable ({long_date(stats['referenceDate'])}): Day is 7:00–20:00, Rush hour "
            "7:00–9:00, and Night 1:30–3:30 the following morning, when the U-Bahn and most of the S-Bahn have stopped and "
            "night buses and night trams take over. Waits are capped at 15 minutes by day and 30 minutes at night.",
        ),
        (
            "What does the bike option do?",
            "It replaces the walk to the first stop and from the last one (or the whole trip, when that is quicker) with a "
            "bike ride at 15 km/h, plus 2 minutes to unlock and park. Stations up to 6 km away are then worth reaching. "
            "Changes between lines are still on foot, and taking the bike along is assumed to be allowed.",
        ),
        (
            "How are travel times calculated?",
            "For each trip: walking to the stop at 4.5 km/h, waiting half of the time between two departures, the scheduled "
            "time between stops, and 1.5 minutes of walking for each change (plus a minute or so to reach underground and "
            "main-line platforms). The Spree, the Havel, the Dahme, the big canals and the lakes can only be crossed over a "
            "bridge. No real-time data or disruptions: this is the city “on paper”.",
        ),
    ]
    credits = (
        "Who made this map?",
        'It adapts <a href="https://tram.camilleroux.com/">À portée de tram</a> by '
        '<a href="https://www.camilleroux.com/">Camille Roux</a> (MIT licence) to Berlin, in English and with every mode '
        'of transport. The idea comes from Anthony Castrio\'s <a href="https://castrio.me/nyc/">NYC Transit Time '
        'Cartogram</a>, adapted to Paris by Jules Grandin '
        '(<a href="https://julesgrandin.github.io/paris-temps-transport/">C\'est encore loin ?</a>).',
    )
    return [(question, escape(answer)) for question, answer in plain] + [credits]


def strip_tags(text: str) -> str:
    return unescape(re.sub(r"<[^>]+>", "", text))


def meet_faq_entries() -> list[tuple[str, str]]:
    plain = [
        (
            "How is the best spot chosen?",
            "For every U-Bahn, S-Bahn, tram and train station in Berlin, the travel time from each person is computed with "
            "the same model as the main map. “Fairest” ranks stations by the longest of those trips, so nobody travels much "
            "longer than the others; “Fastest on average” ranks them by the average trip, which can leave one person with "
            "a long ride. The three best stations at least 900 m apart are listed.",
        ),
        (
            "What does the colour show?",
            "For each point of the city, the longest trip anyone in the group would make to get there (or the average "
            "trip, with “Fastest on average”). Hover anywhere to see each person's time.",
        ),
        (
            "How do I add, move or remove people?",
            "Click the map or search for an address to add someone, up to five. Drag a marker to move it, double-click it "
            "(or use Remove in the list) to take it away. The link in the address bar keeps everyone: share it with the group.",
        ),
    ]
    return [(question, escape(answer)) for question, answer in plain]


def faq_html(faq: list[tuple[str, str]]) -> str:
    return "\n".join(f'        <details class="faq"><summary>{escape(q)}</summary><p>{a}</p></details>' for q, a in faq)


def json_ld(config: dict, name: str, description: str, faq: list[tuple[str, str]]) -> str:
    # Answers are written in HTML (links); the structured data gets their plain text.
    graph = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "WebApplication",
                "name": name,
                "description": description,
                "inLanguage": "en",
                "applicationCategory": "TravelApplication",
                "operatingSystem": "Web",
                "isAccessibleForFree": True,
                "spatialCoverage": {"@type": "Place", "name": config["name"]},
                "isBasedOn": ["https://tram.camilleroux.com/", "https://castrio.me/nyc/"],
            },
            {
                "@type": "FAQPage",
                "mainEntity": [
                    {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": strip_tags(a)}} for q, a in faq
                ],
            },
        ],
    }
    return json.dumps(graph, ensure_ascii=False).replace("</", "<\\/")


def render(template: str, **values) -> str:
    return Template((ROOT / "templates" / template).read_text(encoding="utf-8")).substitute(**values)


INDEX_PANEL = """          <aside id="tripPanel" class="trip-panel" aria-live="polite">
            <p class="trip-eyebrow">Start</p>
            <p id="tripFrom" class="trip-from">Loading the network…</p>
            <div id="tripResult" class="trip-result" hidden>
              <div class="trip-row">
                <p class="trip-eyebrow">Destination</p>
                <button id="removeTo" type="button" class="link-button">Remove</button>
              </div>
              <p id="tripTo" class="trip-to"></p>
              <p id="tripDuration" class="trip-duration"></p>
              <ol id="tripSteps" class="trip-steps"></ol>
              <div id="heatFrom" class="segmented" role="group" aria-label="Point the map is coloured from">
                <span>Map from</span>
                <button type="button" data-source="from" aria-pressed="true">Start</button>
                <button type="button" data-source="to" aria-pressed="false">Destination</button>
              </div>
            </div>
            <p id="tripHint" class="trip-hint">Click on the map to set a destination.</p>
          </aside>"""

INDEX_ACTIONS = """            <button id="locate" type="button" class="button">My location</button>
            <button id="swap" type="button" class="button">Swap</button>
            <button id="share" type="button" class="button primary">Share</button>"""

MEET_PANEL = """          <aside id="meetPanel" class="trip-panel meet-panel" aria-live="polite">
            <p class="trip-eyebrow">People</p>
            <ul id="peopleList" class="people-list"></ul>
            <p id="peopleHint" class="trip-hint">Loading the network…</p>
            <div id="objective" class="segmented" role="group" aria-label="What makes a good spot">
              <span>Meet at the</span>
              <button type="button" data-objective="fair" aria-pressed="true" title="Smallest longest trip">Fairest spot</button>
              <button type="button" data-objective="total" aria-pressed="false" title="Smallest average trip">Fastest on average</button>
            </div>
            <div id="spotsBlock" class="spots-block" hidden>
              <p class="trip-eyebrow">Best stations</p>
              <ol id="spotList" class="spot-list"></ol>
            </div>
          </aside>"""


# The same top bar on every page. On the main page the anchors stay on the page (a "./#map" link would reload it
# and drop the start and destination kept in the address); from the meeting planner they lead to the main page.
def nav_links(prefix: str) -> list[tuple[str, str]]:
    return [(f"{prefix}#map", "Map"), ("meet.html", "Where to meet?"), (f"{prefix}#numbers", "Numbers"),
            (f"{prefix}#rankings", "Rankings"), (f"{prefix}#about", "About")]


MEET_ACTIONS = """            <button id="locate" type="button" class="button">Add my location</button>
            <button id="share" type="button" class="button primary">Share</button>"""


def main() -> None:
    config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    stats = json.loads((ROOT / "data" / "stats.json").read_text(encoding="utf-8"))
    lines = stats["lineInfo"]
    # One version for the whole data set (base and the three time windows): they must change together.
    data_files = sorted((SITE / "data").glob(f"{config['slug']}*.json"))
    data_version = hashlib.sha256(b"".join(path.read_bytes() for path in data_files)).hexdigest()[:8]
    city_config = {
        "slug": config["slug"],
        "name": config["name"],
        "dataVersion": data_version,
        "defaultFrom": config["defaultFrom"],
        "searchBbox": config["searchBbox"],
    }
    title = config["siteTitle"]
    shared = dict(
        title=escape(title),
        name=escape(config["name"]),
        network=escape(config["network"]),
        search_example=escape(config["searchExample"]),
        city_config=json.dumps(city_config, ensure_ascii=False).replace("</", "<\\/"),
        styles_version=version(SITE / "styles.css"),
        core_version=version(SITE / "core.js"),
        gtfs_dataset=config["gtfsDataset"],
        gtfs_attribution=escape(config["gtfsAttribution"]),
        gtfs_licence=escape(config["gtfsLicence"]),
        gtfs_licence_url=config["gtfsLicenceUrl"],
        fetched_day=short_date(stats["gtfsFetchedAt"]),
        districts_dataset=config["districtsDataset"],
        districts_licence=escape(config["districtsLicence"]),
    )

    def map_card(panel: str, actions: str, legend_title: str) -> str:
        return render("map.html", panel=panel, actions=actions, legend_title=legend_title, mode_toggles=mode_toggles())

    def nav(links: list[tuple[str, str]]) -> str:
        return "\n".join(f'        <a href="{href}">{label}</a>' for href, label in links)

    # Main page: one start.
    description = (
        f"Travel time map of {config['name']}: pick a starting point and the whole city is coloured by how long it takes "
        f"to get there by U-Bahn, S-Bahn, tram, regional train, bus and ferry, by day, at rush hour or at night "
        f"({config['network']} timetable)."
    )
    faq = faq_entries(config, stats, lines)
    main_html = render(
        "index.html",
        **shared,
        map=map_card(INDEX_PANEL, INDEX_ACTIONS, "Travel time"),
        stat_cards=stat_cards(stats, lines),
        line_tables=line_tables(stats),
        ranking_cards=ranking_cards(stats, lines),
        reference_day=long_date(stats["referenceDate"]),
        faq=faq_html(faq),
    )
    page = render(
        "base.html",
        **shared,
        page_title=f"{escape(title)} · Travel times by U-Bahn, S-Bahn, tram, train, bus and ferry",
        og_title=escape(title),
        description=escape(description),
        json_ld=json_ld(config, title, description, faq),
        nav=nav(nav_links("")),
        main=main_html,
        script="app.js",
        script_version=version(SITE / "app.js"),
    )
    (SITE / "index.html").write_text(page, encoding="utf-8")

    # Meeting planner: up to five people.
    description = (
        f"Where to meet in {config['name']}: add up to five people and find the station everyone reaches fastest by "
        f"public transport, by day, at rush hour or at night."
    )
    faq = meet_faq_entries()
    main_html = render(
        "meet.html",
        **shared,
        map=map_card(MEET_PANEL, MEET_ACTIONS, "Longest trip among everyone"),
        faq=faq_html(faq),
    )
    page = render(
        "base.html",
        **shared,
        page_title=f"Where to meet? · {escape(title)}",
        og_title=f"Where to meet? · {escape(title)}",
        description=escape(description),
        json_ld=json_ld(config, f"{title}: where to meet", description, faq),
        nav=nav(nav_links("./")),
        main=main_html,
        script="meet.js",
        script_version=version(SITE / "meet.js"),
    )
    (SITE / "meet.html").write_text(page, encoding="utf-8")
    print(f"Wrote site/index.html and site/meet.html (built {datetime.now():%Y-%m-%d %H:%M})")


if __name__ == "__main__":
    main()
