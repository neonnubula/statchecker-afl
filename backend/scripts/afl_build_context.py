#!/usr/bin/env python3
"""Build a local, inspectable AFL context artifact from cached source evidence."""
import argparse
from datetime import date, datetime, timezone
from html import escape
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.afl_context import build_context


APPOINTMENT_STATUS = "announced_appointments_not_independently_verified_as_officiated"


def validate_appointments(sample):
    """Validate a bounded transcription without mapping names to games or people."""
    def text(value, label, limit=200):
        if not isinstance(value, str) or not value.strip() or len(value) > limit:
            raise ValueError(f"Invalid appointment {label}")
        return value.strip()

    if not isinstance(sample, dict):
        raise ValueError("Appointments must be an object")
    source = urlparse(text(sample.get("source_url"), "source URL", 1000))
    if (source.scheme != "https" or source.netloc not in {"aflua.com.au", "www.aflua.com.au"}
            or not source.path.startswith("/wp-content/uploads/") or not source.path.lower().endswith(".pdf")
            or source.query or source.fragment):
        raise ValueError("Appointments require an HTTPS AFLUA source PDF")
    if (sample.get("source") != "AFLUA published appointments" or sample.get("competition") != "AFL"
            or sample.get("status") != APPOINTMENT_STATUS):
        raise ValueError("Appointments require AFLUA source and announced-only status")
    season, round_number = sample.get("season"), sample.get("round")
    if type(season) is not int or not 2000 <= season <= 2100 or type(round_number) is not int or not 0 <= round_number <= 40:
        raise ValueError("Invalid appointment season or round")
    digest = sample.get("source_sha256")
    if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("Appointments require the source PDF SHA-256")
    stamp = text(sample.get("retrieved_at"), "retrieval time")
    retrieved = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    if retrieved.tzinfo is None or retrieved > datetime.now(timezone.utc):
        raise ValueError("Appointment retrieval time must be timezone-aware and not future")
    extraction = text(sample.get("extraction"), "extraction method", 2000)
    appointments = sample.get("appointments")
    if not isinstance(appointments, list) or not 1 <= len(appointments) <= 20:
        raise ValueError("Expected 1–20 appointment fixtures")
    rows, seen = [], set()
    for row in appointments:
        if not isinstance(row, dict):
            raise ValueError("Invalid appointment fixture")
        local_date = text(row.get("local_date"), "local date")
        day = date.fromisoformat(local_date)
        if day.year != season or day.isoformat() != local_date:
            raise ValueError("Appointment date outside source season")
        local_time = text(row.get("local_time"), "local time")
        if not re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", local_time):
            raise ValueError("Invalid appointment local time")
        home, away = (text(row.get(k), k) for k in ("home_team_source", "away_team_source"))
        key = (local_date, home, away)
        if home == away or key in seen:
            raise ValueError("Duplicate or conflicting appointment fixture")
        seen.add(key)
        crew = row.get("field_umpires")
        if not isinstance(crew, list) or not 1 <= len(crew) <= 8:
            raise ValueError("Expected a bounded nonempty field-umpire crew")
        officials, names, shirts = [], set(), set()
        for official in crew:
            if not isinstance(official, dict):
                raise ValueError("Invalid field umpire")
            shirt = official.get("shirt_number")
            name = text(official.get("name_source"), "field umpire name")
            if type(shirt) is not int or not 1 <= shirt <= 999 or shirt in shirts or name in names:
                raise ValueError("Invalid or duplicate field umpire within a crew")
            shirts.add(shirt)
            names.add(name)
            officials.append({"shirt_number": shirt, "name_source": name})
        rows.append({"local_date": local_date, "local_time": local_time, "home_team_source": home,
                     "away_team_source": away, "venue_source": text(row.get("venue_source"), "venue"),
                     "field_umpires": officials})
    return {"source": sample["source"], "source_url": source.geturl(), "retrieved_at": stamp,
            "source_sha256": digest, "competition": "AFL", "season": season, "round": round_number,
            "status": APPOINTMENT_STATUS, "extraction": extraction, "appointments": rows}


def render_appointments(sample):
    if sample is None:
        return ""
    sample = validate_appointments(sample)
    rows = []
    for fixture in sample["appointments"]:
        crew = "; ".join(f"{o['name_source']} (shirt {o['shirt_number']})" for o in fixture["field_umpires"])
        rows.append(f"<tr><td>{escape(fixture['home_team_source'])} v {escape(fixture['away_team_source'])}"
                    f"<small>{escape(fixture['local_date'])} {escape(fixture['local_time'])} · {escape(fixture['venue_source'])}</small>"
                    f"</td><td style=\"white-space:normal;min-width:260px\">{escape(crew)}</td></tr>")
    count = sum(len(r["field_umpires"]) for r in sample["appointments"])
    return (f'<details id="appointments" class="notes"><summary style="cursor:pointer;font-weight:700">'
            f"Announced field-umpire sample · {len(rows)} fixtures · {count} name entries</summary>"
            f"<p>AFL {sample['season']} · Round {sample['round']}. These are published appointments, "
            "not independently verified as the officials who worked the matches. Source names and shirt numbers "
            "are preserved; no player, match or referee identity joins have been made.</p>"
            "<p>Times are the source's local wall-clock times. Retrieval after these games does not establish "
            "when the appointments became available before play. This sample does not measure umpire effects.</p>"
            f'<p>Source: <a href="{escape(sample["source_url"], quote=True)}">AFLUA published appointment PDF</a>'
            f" · Retrieved {escape(sample['retrieved_at'])}</p>"
            f"<p>{escape(sample['extraction'])}</p>"
            '<div class="table"><table><thead><tr><th>Source fixture / local start</th><th>Announced field umpires</th></tr></thead>'
            f"<tbody>{''.join(rows)}</tbody></table></div>"
            f'<p style="overflow-wrap:anywhere">Source PDF SHA-256: {sample["source_sha256"]}</p></details>')


def render_report(context, appointments=None):
    appointments_html = render_appointments(appointments if appointments is not None else context.get("appointments_sample"))
    data = json.dumps(context, ensure_ascii=True).replace("<", "\\u003c")
    attributions = sorted({(v.get("attribution", ""), v.get("license", ""), v.get("license_url", ""))
                           for g in context["games"] if (v := g.get("venue_evidence"))
                           if v.get("attribution")})
    # Attribution must be visible in the artifact, not just embedded in its JSON.
    data_attribution = json.dumps(attributions, ensure_ascii=True).replace("<", "\\u003c")
    template = """<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AFL context evidence | StatChecker</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f6f4;color:#182d24;font:15px system-ui,sans-serif}main{max-width:1200px;margin:auto;padding:48px 24px}header{border-top:5px solid #11845b;padding-top:25px}h1{font-size:42px;letter-spacing:-1.5px;margin:10px 0}h2{font-size:18px}p{line-height:1.6;max-width:850px}.eyebrow{font-size:12px;font-weight:750;letter-spacing:2px;color:#127552}.muted{color:#57675e}.stats{display:flex;gap:14px;flex-wrap:wrap;margin:28px 0}.stat{background:white;border:1px solid #d9e4dd;border-radius:12px;padding:18px 24px;min-width:180px}.stat strong{display:block;font-size:28px}.filters{display:flex;gap:20px;align-items:end;flex-wrap:wrap;margin:28px 0 18px}label{display:grid;gap:7px;font-size:13px;font-weight:650}select{padding:11px;border:1px solid #baccc0;border-radius:7px;background:white;font-size:15px;max-width:100%}.table{overflow:auto;background:white;border:1px solid #d9e4dd;border-radius:12px}table{width:100%;border-collapse:collapse;text-align:left;white-space:nowrap}th{background:#eaf2ec;color:#3b5446;font-size:11px;text-transform:uppercase;letter-spacing:.6px}td,th{padding:15px 16px;border-bottom:1px solid #e6ece8}td{font-size:13px}td small{display:block;color:#6d7971;margin-top:4px}.notes{background:#e9f0eb;border-radius:12px;padding:18px 24px;margin-top:24px}.pill{display:inline-block;background:#dcece2;padding:4px 8px;border-radius:5px;font-size:11px}a{color:#0b7650}footer{font-size:12px;color:#65736a;margin-top:24px}@media(max-width:600px){main{padding:26px 16px}h1{font-size:33px}.stat{flex:1;min-width:140px;padding:15px}.filters{display:block}label{margin:12px 0}}
</style><main><header><div class="eyebrow">STATCHECKER / AFL CONTEXT LAB</div><h1>The journey between games.</h1><p class="muted">A separate evidence snapshot for team turnaround, recent workload and ground-to-ground distance. This is a research artifact, not a live member feature or a forecast.</p></header><div id="stats" class="stats"></div><div class="filters"><label>Team<select id="team"><option value="all">All teams</option></select></label><label>Matches<select id="state"><option value="all">All recorded matches</option><option value="final">Completed</option><option value="scheduled">Scheduled</option></select></label></div><p id="count" class="muted" aria-live="polite"></p><div class="table"><table><thead><tr><th>Match / local start</th><th>Team / previous ground</th><th>Turnaround</th><th>Ground distance</th><th>Clock change</th><th>Prior 14 / 28 days</th></tr></thead><tbody id="rows"></tbody></table></div><div class="notes"><h2>Read the evidence correctly</h2><p id="method"></p><p>“Unavailable” means the source or previous match is unresolved. Distance uses approximate ground coordinates where sourced; it excludes flights, returns home and training bases. Clock change is east/west between venues, not measured jet lag. Workload is an observed count, not guaranteed complete history. Unresolved future teams are not joined into histories; a match with both teams unknown has no team observation to display.</p><p>Umpire appointments are a separate source-validation track. No umpire bias or travel effect is included in these numbers.</p></div><footer id="source"></footer></main><script>
const data = CONTEXT_DATA;
const attributions = ATTRIBUTION_DATA;
const e = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const teams = new Map();for(const g of data.games){if(g.home_team_id)teams.set(g.home_team_id,g.home_team);if(g.away_team_id)teams.set(g.away_team_id,g.away_team)}
document.querySelector('#team').insertAdjacentHTML('beforeend',[...teams].sort((a,b)=>a[1].localeCompare(b[1])).map(([id,name])=>`<option value="${e(id)}">${e(name)}</option>`).join(''));
document.querySelector('#stats').innerHTML = [[data.coverage.games,'source matches'],[data.coverage.completed,'completed matches'],[data.coverage.unresolved_team_games,'matches with unresolved teams'],[`${data.coverage.venues_with_coordinates} / ${data.coverage.venues_total}`,'grounds with coordinates']].map(([n,t])=>`<div class="stat"><strong>${e(n)}</strong>${e(t)}</div>`).join('');
document.querySelector('#method').textContent=data.method;
document.querySelector('#source').innerHTML=`Source: <a href="${e(data.source_url)}">Squiggle season snapshot</a> · Retrieved ${e(data.retrieved_at)}<p>${e(data.coverage.scope)}</p>`;
document.querySelector('#source').insertAdjacentHTML('beforeend',attributions.map(([name,license,url])=>`<p>Venue coordinates: ${e(name)}${url?' · <a href="'+e(url)+'">'+e(license||'License')+'</a>':''}</p>`).join(''));
function draw(){const tid=document.querySelector('#team').value,state=document.querySelector('#state').value;let n=0;document.querySelector('#rows').innerHTML=[...data.games].reverse().filter(g=>state==='all'||g.state===state).flatMap(g=>Object.entries(g.teams).filter(([id])=>tid==='all'||id===tid).map(([id,c])=>{n++;return `<tr><td>${e(g.home_team??'Team TBC')} v ${e(g.away_team??'Opponent TBC')}<small>${e(g.source_local_time.replace('T',' '))} · ${e(g.round_name)} · ${e(g.venue)}</small><small>${e(g.state)}</small></td><td><strong>${e(teams.get(id))}</strong><small>Previous: ${e(c.previous_venue??'Unavailable')}</small></td><td>${c.start_gap_hours==null?'Unavailable':e(c.start_gap_hours)+' hours'}<small>${c.calendar_gap_days==null?'Previous match unresolved':e(c.calendar_gap_days)+' calendar days · '+e(c.off_days)+' off-days'}</small></td><td>${c.venue_distance_km==null?'Unavailable':'≈ '+e(c.venue_distance_km)+' km'}${g.venue_evidence?'<small><a href="'+e(g.venue_evidence.source_url)+'">Ground source</a></small>':''}</td><td>${c.venue_clock_shift_hours==null?'Unavailable':(c.venue_clock_shift_hours>0?'+':'')+e(c.venue_clock_shift_hours)+'h'}</td><td>${e(c.games_previous_14_days??'—')} / ${e(c.games_previous_28_days??'—')} games</td></tr>`})).join('');document.querySelector('#count').textContent=n+' team-match observations';}
document.querySelector('#team').addEventListener('change',draw);document.querySelector('#state').addEventListener('change',draw);draw();
</script></html>"""
    replacements = {"CONTEXT_DATA": data, "ATTRIBUTION_DATA": data_attribution}
    # One pass keeps source text resembling a marker from being substituted again.
    rendered = re.sub(r"CONTEXT_DATA|ATTRIBUTION_DATA", lambda match: replacements[match.group()], template)
    return rendered.replace('<div class="filters">', appointments_html + '<div class="filters">', 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, required=True, help="Cached source envelope (source/source_url/retrieved_at/payload)")
    parser.add_argument("--venues", type=Path, help="Optional verified venue coordinate/timezone registry")
    parser.add_argument("--appointments", type=Path, help="Optional local AFLUA announced-appointment sample; kept separate from schedule histories")
    parser.add_argument("--output", type=Path, required=True, help="New local JSON artifact; matching HTML also generated")
    args = parser.parse_args()
    output = args.output.expanduser().resolve()
    report = output.with_suffix(".html")
    if output.suffix != ".json" or str(output).startswith("/mnt/"):
        parser.error("Use a separate local .json artifact, not a production volume")
    if output.exists() or report.exists():
        parser.error("Output already exists; choose a new artifact name")
    envelope = json.loads(args.snapshot.read_text())
    venues = json.loads(args.venues.read_text()) if args.venues else {}
    context = build_context(envelope, venues)
    if args.appointments:
        context["appointments_sample"] = validate_appointments(json.loads(args.appointments.read_text()))
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(context, indent=2)+"\n")
    report.write_text(render_report(context))
    print(json.dumps({"json": str(output), "report": str(report), "coverage": context["coverage"]}))


if __name__ == "__main__":
    main()
