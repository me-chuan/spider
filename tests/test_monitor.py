"""Offline regression tests for cache, response handling, and dashboard state."""

import contextlib
import io
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


try:
    import requests  # noqa: F401
except ImportError:
    # The tests exercise local logic only; the real application still needs requests.
    fake_requests = types.ModuleType("requests")
    fake_requests.Response = object
    fake_requests.post = Mock()
    sys.modules["requests"] = fake_requests

import config
import main as main_module
import monitor


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.target = {"name": "Gym", "venueId": "venue", "fieldType": "gym"}
        self.cookie_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.cookie_directory.cleanup)
        self.cookie_path_patch = patch.object(
            config, "COOKIE_FILE_PATH", Path(self.cookie_directory.name) / "cookies.json"
        )
        self.cookie_path_patch.start()
        self.addCleanup(self.cookie_path_patch.stop)

    def test_cookie_configuration_comes_from_environment(self):
        with patch.dict(os.environ, {"SJTU_JSESSIONID": "example", "SJTU_COOKIES_JSON": ""}, clear=True):
            self.assertEqual(config.load_cookies(), {"JSESSIONID": "example"})
        with patch.dict(os.environ, {"SJTU_COOKIES_JSON": '{"JSESSIONID":"example","other":"x"}'}, clear=True):
            self.assertEqual(config.load_cookies()["other"], "x")
        with patch.dict(os.environ, {"SJTU_COOKIES_JSON": '{"_ga":"analytics"}', "SJTU_JSESSIONID": "real-session"}, clear=True):
            self.assertEqual(config.load_cookies(), {"_ga": "analytics", "JSESSIONID": "real-session"})
        with patch.dict(os.environ, {
            "SJTU_COOKIES_JSON": '{"JSESSIONID":"stale"}',
            "SJTU_COOKIE_HEADER": "JSESSIONID=fresh; other=part$g1=value",
        }, clear=True):
            self.assertEqual(config.load_cookies(), {"JSESSIONID": "fresh", "other": "part$g1=value"})
        with patch.dict(os.environ, {
            "SJTU_COOKIES_JSON": "not valid JSON",
            "SJTU_JSESSIONID": "stale",
            "SJTU_COOKIE_HEADER": "_ga=analytics; another=part$g1=value",
        }, clear=True):
            self.assertEqual(config.load_cookies(), {"_ga": "analytics", "another": "part$g1=value"})

    def test_local_cookie_file_ignores_stale_environment(self):
        config.COOKIE_FILE_PATH.write_text(
            '{"cookie_header":"first=one; second=part$g1=value"}', encoding="utf-8"
        )
        with patch.dict(os.environ, {"SJTU_COOKIES_JSON": "not valid JSON"}, clear=True):
            self.assertEqual(config.load_cookies(), {"first": "one", "second": "part$g1=value"})

    def test_cache_separates_field_types_and_retries_failed_refresh(self):
        cache = monitor._empty_cache()
        other = {**self.target, "name": "Badminton", "fieldType": "badminton"}
        with patch.object(monitor, "fetch_date_ids", side_effect=[{"day": "gym-id"}, {"day": "bad-id"}]):
            monitor.get_or_refresh_date_id_map(self.target, cache, "2026-10-10")
            monitor.get_or_refresh_date_id_map(other, cache, "2026-10-10")
        self.assertEqual(len(cache["by_target"]), 2)
        self.assertEqual(
            monitor.get_or_refresh_date_id_map(self.target, cache, "2026-10-10"),
            {"day": "gym-id"},
        )
        with patch.object(monitor, "fetch_date_ids", side_effect=ValueError("temporary outage")):
            with self.assertRaisesRegex(ValueError, "temporary outage"):
                monitor.get_or_refresh_date_id_map(self.target, cache, "2026-10-11")
        key = monitor._cache_key("venue", "gym")
        self.assertEqual(cache["by_target"][key]["cache_date"], "2026-10-10")
        with patch.object(monitor, "fetch_date_ids", return_value={"next-day": "new-id"}) as fetch:
            self.assertEqual(
                monitor.get_or_refresh_date_id_map(self.target, cache, "2026-10-11"),
                {"next-day": "new-id"},
            )
            fetch.assert_called_once()

    def test_old_cache_format_is_refreshed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "cache.json")
            with open(path, "w", encoding="utf-8") as file:
                json.dump({"version": 1, "cache_date": "2026-10-10", "by_venue": {}}, file)
            with patch.object(monitor, "DATE_ID_CACHE_PATH", path):
                self.assertEqual(monitor.load_date_id_cache(), monitor._empty_cache())

    def test_forced_date_refresh_updates_each_field_type(self):
        other = {**self.target, "name": "Badminton", "fieldType": "badminton"}
        cache = monitor._empty_cache()
        with patch.object(monitor, "TARGET_CONFIGS", [self.target, other]), patch.object(
            monitor, "load_date_id_cache", return_value=cache
        ), patch.object(monitor, "fetch_date_ids", side_effect=[{"day": "gym-id"}, {"day": "bad-id"}]), patch.object(
            monitor, "save_date_id_cache"
        ) as save, contextlib.redirect_stdout(io.StringIO()):
            monitor.refresh_all_date_ids_for_today()
        save.assert_called_once_with(cache)
        self.assertEqual(cache["by_target"]["venue|gym"]["date_id_map"], {"day": "gym-id"})
        self.assertEqual(cache["by_target"]["venue|badminton"]["date_id_map"], {"day": "bad-id"})

    def test_api_failure_is_not_treated_as_no_availability(self):
        with self.assertRaisesRegex(monitor.AuthenticationError, "API error 401"):
            monitor.parse_slots_from_json({"code": 401, "msg": "login expired", "data": []})
        with self.assertRaisesRegex(ValueError, "valid availability count"):
            monitor.parse_slots_from_json(
                {"code": 0, "data": [{"priceList": [{"status": "open"}]}]}
            )
        slots = monitor.parse_slots_from_json(
            {"code": 0, "data": [{"fieldName": "Court A", "fieldId": "a", "priceList": [{"count": 2}, {"count": 0}, {"count": -1}]}]}
        )
        self.assertEqual([(slot["time"], slot["count"]) for slot in monitor.filter_slots(slots)], [("07:00-08:00", 2)])

    def test_authentication_failure_stops_preparation_after_first_target(self):
        with patch.object(monitor, "load_date_id_cache", return_value=monitor._empty_cache()), patch.object(
            monitor, "fetch_date_ids", side_effect=monitor.AuthenticationError("API error 401")
        ) as fetch:
            with self.assertRaises(monitor.AuthenticationError):
                monitor._prepare_monitoring_tasks_core([self.target, self.target])
        fetch.assert_called_once()

    def test_authentication_failure_exits_with_guidance(self):
        with patch.object(monitor, "COOKIES", {"_ga": "example"}), patch.object(
            monitor, "_prepare_monitoring_tasks_core",
            side_effect=monitor.AuthenticationError("API error 401"),
        ):
            with self.assertRaises(SystemExit) as raised:
                monitor.main_loop([self.target])
        self.assertIn("cookies.json", str(raised.exception))
        self.assertIn("_ga", str(raised.exception))

    def test_ctrl_c_exits_without_traceback(self):
        output = io.StringIO()
        with patch.object(main_module, "main", side_effect=KeyboardInterrupt), contextlib.redirect_stdout(output):
            main_module.run_cli()
        self.assertIn("监控已停止", output.getvalue())

    def test_new_slot_alerts_once_and_errors_keep_last_known_state(self):
        known = {}
        slot = {
            "top_venue_id": "venue", "venue_id": "court", "venue": "Court A",
            "date": "2026-10-10", "time": "19:00-20:00", "count": 2,
        }
        new, changed = monitor._record_available_slots("task", [slot], known)
        self.assertEqual(new, [slot])
        self.assertTrue(changed)
        new, changed = monitor._record_available_slots("task", [slot], known)
        self.assertEqual(new, [])
        self.assertFalse(changed)
        self.assertIn("task", known)  # An unsuccessful request does not call this helper.
        new, changed = monitor._record_available_slots("task", [], known)
        self.assertEqual(new, [])
        self.assertTrue(changed)
        new, changed = monitor._record_available_slots("task", [slot], known)
        self.assertEqual(new, [slot])
        self.assertTrue(changed)

    def test_dashboard_distinguishes_pending_available_unavailable_and_failed(self):
        tasks = [
            {"key": status, "top_venue_name": status, "target_date": "2026-10-10"}
            for status in ("pending", "available", "unavailable", "error")
        ]
        slot = {
            "top_venue_name": "Gym", "venue": "Court A", "date": "2026-10-10",
            "time": "19:00-20:00", "count": 2, "checked_at": "12:34:56",
        }
        results = {
            "pending": {"status": "pending", "slots": [], "checked_at": None, "detail": ""},
            "available": {"status": "available", "slots": [slot], "checked_at": "12:34:56", "detail": "1 slot"},
            "unavailable": {"status": "unavailable", "slots": [], "checked_at": "12:34:57", "detail": ""},
            "error": {"status": "error", "slots": [], "checked_at": "12:34:58", "detail": "API error"},
        }
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            monitor._render_status_panel(
                cycle_no=1, total_checks=3, tasks=tasks, results=results,
                current_check=None, last_change_at=None, sleep_left=None,
                recent_errors=[], preparation_errors=[], alert_banner=None,
            )
        shown = output.getvalue()
        self.assertIn("Pending 1  Available 1  No availability 1  Failed 1", shown)
        self.assertIn("Gym / Court A | 2026-10-10 19:00-20:00 | 2 left | checked 12:34:56", shown)
        for status in ("PENDING", "AVAILABLE", "UNAVAILABLE", "ERROR"):
            self.assertIn(status, shown)

    def test_midnight_rebuilds_tasks(self):
        with patch.object(monitor, "COOKIES", {"JSESSIONID": "test"}), patch.object(
            monitor, "_today_str", side_effect=["2026-10-10", "2026-10-11"]
        ), patch.object(
            monitor, "_prepare_monitoring_tasks_core", return_value=([], [])
        ) as prepare, patch.object(
            monitor, "_render_status_panel"
        ), patch.object(
            monitor.time, "sleep", side_effect=[None, StopIteration]
        ):
            with self.assertRaises(StopIteration):
                monitor.main_loop([self.target])
        self.assertEqual(prepare.call_count, 2)

    def test_unchanged_availability_does_not_ring_each_cycle(self):
        task = {
            "key": "venue|gym|2026-10-10", "top_venue_name": "Gym",
            "top_venue_id": "venue", "target_date": "2026-10-10", "payload": {},
        }
        slot = {
            "top_venue_id": "venue", "venue_id": "court", "venue": "Court A",
            "top_venue_name": "Gym", "date": "2026-10-10", "time": "19:00-20:00",
            "count": 2, "checked_at": "12:34:56",
        }
        with patch.object(monitor, "COOKIES", {"JSESSIONID": "test"}), patch.object(
            monitor, "_today_str", return_value="2026-10-10"
        ), patch.object(
            monitor, "_prepare_monitoring_tasks_core", return_value=([task], [])
        ), patch.object(
            monitor, "_fetch_available_slots", return_value=[slot]
        ), patch.object(
            monitor, "_render_status_panel"
        ), patch.object(
            monitor, "_terminal_bell"
        ) as bell, patch.object(
            monitor.time, "sleep", side_effect=[None, None, None, StopIteration]
        ):
            with self.assertRaises(StopIteration):
                monitor.main_loop([self.target])
        bell.assert_called_once()


if __name__ == "__main__":
    unittest.main()
