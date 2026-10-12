"""Трей и работа в фоне: крестик прячет окно (dsh работает дальше), повторный
запуск и выключение трея возвращают окно; «агент закончил» — точка на
значке трея."""
from helpers.env import FAKE, NOUPD
from helpers.procs import as_tester, wait_port


def enable_tray(gui, launcher):
    settings = gui.open_settings()
    settings.set('closeToTray', 'true')
    settings.wait_note('Saved')
    assert launcher.wait_log('трей включён', 5)
    settings.close()


def test_close_to_tray(start, gui):
    launcher = start(FAKE, NOUPD)
    gui.wait()
    enable_tray(gui, launcher)
    gui.mark()

    gui.go('dshlauncher://window/close/')  # то же, что крестик
    assert launcher.wait_log('окно спрятано в трей', 5)
    assert launcher.alive and wait_port(5), 'лаунчер и dsh работают дальше'

    # повторный запуск лаунчера возвращает спрятанное окно
    as_tester('DISPLAY=:99 HOME=/home/tester /usr/bin/dsh-launcher >/dev/null 2>&1')
    assert launcher.wait_log('окно показано из трея', 15)
    assert gui.not_reloaded(), 'GUI dsh не перезагружался'
    launcher.term()


def test_tray_off_shows_window(start, gui):
    """Трей выключили, пока окно спрятано, — окно показывается (без значка его
    было бы не вернуть)."""
    launcher = start(FAKE, NOUPD)
    gui.wait()
    enable_tray(gui, launcher)
    gui.go('dshlauncher://window/close/')
    assert launcher.wait_log('окно спрятано в трей', 5)

    gui.go('dshlauncher://settings/set/?k=closeToTray&v=false')
    assert launcher.wait_log('трей выключен', 5)
    assert launcher.wait_log('окно показано из трея', 5)
    launcher.term()


def test_agent_finished(start, gui):
    """Окно в трее, агент закончил ответ (индикатор [data-chat-running] в чате
    исчез) — системное уведомление, точка на значке трея и (включён) звук; агент
    ждёт подтверждения команды или ответа на вопрос — тот же сигнал."""
    launcher = start(FAKE, NOUPD)
    gui.wait()
    enable_tray(gui, launcher)
    gui.go('dshlauncher://settings/set/?k=attentionSound&v=true')
    assert launcher.wait_log('звук: агент закончил ответ', 5), 'включили звук — сразу пробный сигнал'
    gui.go('dshlauncher://window/close/')
    assert launcher.wait_log('окно спрятано в трей', 5)

    gui.eval("document.body.insertAdjacentHTML('beforeend', '<div id=\"run\" data-chat-running></div>')")
    assert launcher.wait_log('агент отвечает', 10)
    gui.eval("document.getElementById('run').remove()")
    assert launcher.wait_log('агент закончил ответ — окно в трее', 10)
    assert launcher.wait_log('значок трея: агент закончил ответ', 5)
    assert 'уведомление: агент закончил ответ' in launcher.log(), 'системное уведомление'
    assert launcher.log().count('звук: агент закончил ответ') == 2, 'и звук'

    # агент остановился и ждёт подтверждения команды — тот же сигнал
    gui.eval("document.body.insertAdjacentHTML('beforeend', '<div id=\"ask\" data-approval-key=\"k1\"></div>')")
    assert launcher.wait_log('агент ждёт: подтверждение команды — окно в трее', 10)
    assert launcher.wait_log('уведомление: агент ждёт: подтверждение команды', 5)
    # ответили (панель занята ответом) — повторно не сообщает
    gui.eval("document.getElementById('ask').setAttribute('aria-busy', 'true')")
    gui.eval("document.body.insertAdjacentHTML('beforeend', '<div id=\"q\" data-question-key=\"k2\"></div>')")
    assert launcher.wait_log('агент ждёт: ответ на вопрос', 10), 'вопрос агента'
    assert launcher.log().count('] агент ждёт: подтверждение команды — ') == 1, 'то же ожидание — сообщено один раз'
    launcher.term()
