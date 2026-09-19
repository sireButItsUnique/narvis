"""Real mouse and keyboard events on Windows (SendInput), plus screen size and a global key check."""
import ctypes
from ctypes import wintypes

user32 = ctypes.WinDLL('user32', use_last_error=True)

# so screen sizes and coordinates are real pixels on scaled (125%, 150%...) displays
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except (AttributeError, OSError):
    user32.SetProcessDPIAware()

INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
MOVE, ABSOLUTE, WHEEL = 0x0001, 0x8000, 0x0800
BUTTON_FLAGS = {'left': (0x0002, 0x0004), 'right': (0x0008, 0x0010), 'middle': (0x0020, 0x0040)}
KEYUP = 0x0002
VK = {'shift': 0x10, 'ctrl': 0x11, 'alt': 0x12, 'f8': 0x77, 'esc': 0x1B}
ULONG_PTR = ctypes.c_size_t


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [('dx', wintypes.LONG), ('dy', wintypes.LONG), ('mouseData', wintypes.DWORD),
                ('dwFlags', wintypes.DWORD), ('time', wintypes.DWORD), ('dwExtraInfo', ULONG_PTR)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [('wVk', wintypes.WORD), ('wScan', wintypes.WORD), ('dwFlags', wintypes.DWORD),
                ('time', wintypes.DWORD), ('dwExtraInfo', ULONG_PTR)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [('uMsg', wintypes.DWORD), ('wParamL', wintypes.WORD), ('wParamH', wintypes.WORD)]


class _U(ctypes.Union):
    _fields_ = [('mi', MOUSEINPUT), ('ki', KEYBDINPUT), ('hi', HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ('u',)
    _fields_ = [('type', wintypes.DWORD), ('u', _U)]


def screen_size():
    """Primary monitor, in pixels."""
    return user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)


def cursor_pos():
    """Where the real pointer is now (so a drag can start from it)."""
    p = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(p))
    return p.x, p.y


def _send(*inputs):
    arr = (INPUT * len(inputs))(*inputs)
    user32.SendInput(len(inputs), arr, ctypes.sizeof(INPUT))


def _mouse(flags, dx=0, dy=0, data=0):
    return INPUT(type=INPUT_MOUSE, mi=MOUSEINPUT(dx, dy, data & 0xFFFFFFFF, flags, 0, 0))


def move(x, y):
    w, h = screen_size()
    _send(_mouse(MOVE | ABSOLUTE, round(x * 65535 / max(1, w - 1)), round(y * 65535 / max(1, h - 1))))


def button(name, down):
    _send(_mouse(BUTTON_FLAGS[name][0 if down else 1]))


def wheel(notches):
    _send(_mouse(WHEEL, data=int(notches * 120)))


def key(name, down):
    _send(INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(VK[name], 0, 0 if down else KEYUP, 0, 0)))


def key_is_down(name):
    """Global: works whichever window has focus."""
    return bool(user32.GetAsyncKeyState(VK[name]) & 0x8000)


def perform(action):
    kind = action[0]
    if kind == 'move':
        move(action[1], action[2])
    elif kind in ('down', 'up'):
        button(action[1], kind == 'down')
    elif kind in ('key_down', 'key_up'):
        key(action[1], kind == 'key_down')
    elif kind == 'wheel':
        wheel(action[1])
