"""Дымовые сценарии под Wayland (безголовый weston; только Ubuntu 26.04).
Остальные сценарии — под X11 (Xvfb). В контейнере видеокарты нет — как на ВМ."""
import os

from helpers.env import FAKE, NOUPD
from helpers.procs import wait_exit


def test_wayland_auto(start, gui, wayland):
    """Wayland-сеанс без GPU: лаунчер сам выбирает X11 через XWayland (на ВМ
    нативное Wayland-окно без GPU часто невидимо) — окно показано, GUI загружен."""
    launcher = start(FAKE, NOUPD, wayland)  # DISPLAY остаётся — это «XWayland»
    gui.wait()
    assert 'Wayland-сессия — ozone-platform=x11 (render-узлов нет' in launcher.log(), launcher.log()[:800]
    assert launcher.wait_log('окно показано', 10)
    launcher.term()


def test_wayland_native(start, gui, wayland):
    """Нативный Wayland (DSH_LAUNCHER_OZONE=wayland), X-дисплея нет вовсе: окно
    показано, GUI загружен, диалог — слой в окне — открывается и закрывается,
    «Перезапустить лаунчер» — новый экземпляр снова на Wayland и отвечает."""
    launcher = start(FAKE, NOUPD, wayland, DSH_LAUNCHER_OZONE='wayland', DISPLAY=None)
    gui.wait()
    assert 'Wayland-сессия — ozone-platform=wayland (принудительно: DSH_LAUNCHER_OZONE)' in launcher.log()
    assert launcher.wait_log('окно показано', 10)

    about = gui.open_about()
    assert about.is_overlay(), 'диалог — слой внутри окна'
    about.close()

    gui.open_settings().relaunch()
    assert launcher.wait_exit(20) is not None, 'прежний экземпляр завершился'
    new = launcher.successor()
    assert new, 'лаунчер перезапустился'
    gui.wait()  # окно нового экземпляра — по CDP
    assert launcher.log().count('ozone-platform=wayland (принудительно') == 2, 'новый экземпляр — тоже на Wayland'
    os.kill(new, 15)
    assert wait_exit(new, 15) is not None, 'новый экземпляр штатно завершился'
