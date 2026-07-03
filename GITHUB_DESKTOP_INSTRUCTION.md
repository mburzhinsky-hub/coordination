# Как залить дашборд через GitHub Desktop

## 1. Создать репозиторий на GitHub

1. Открой GitHub.
2. Нажми `New repository`.
3. Название: `bitrix-task-dashboard`.
4. Выбери `Private` или `Public` по своему решению.
5. Нажми `Create repository`.

## 2. Открыть репозиторий в GitHub Desktop

1. В GitHub Desktop нажми `File` → `Clone repository`.
2. Выбери созданный репозиторий.
3. Укажи папку на компьютере.
4. Нажми `Clone`.

## 3. Переложить файлы дашборда

1. Распакуй архив `bitrix-task-dashboard-static.zip`.
2. Скопируй все файлы из распакованной папки в папку репозитория, которую создал GitHub Desktop.
3. Должны появиться файлы:

```text
index.html
README.md
assets/
data/
```

## 4. Сделать первый коммит

1. Вернись в GitHub Desktop.
2. Внизу слева в поле Summary напиши:

```text
Initial static dashboard
```

3. Нажми `Commit to main`.
4. Нажми `Push origin`.

## 5. Включить GitHub Pages

1. Открой репозиторий на GitHub в браузере.
2. Перейди в `Settings`.
3. В левом меню открой `Pages`.
4. В блоке `Build and deployment` выбери:
   - Source: `Deploy from a branch`
   - Branch: `main`
   - Folder: `/root`
5. Нажми `Save`.
6. Подожди 1–3 минуты.
7. Открой ссылку, которую GitHub покажет в разделе Pages.

## 6. Как добавлять новые выгрузки

Каждую новую выгрузку из Битрикс24 клади в:

```text
data/raw/
```

Имя файла:

```text
tasks_YYYY-MM-DD_HH-MM.xls
```

После этого открой файл:

```text
data/exports.json
```

И добавь имя новой выгрузки в список.

Пример:

```json
{
  "files": [
    "tasks_2026-07-03_07-04-17.xls",
    "tasks_2026-07-03_14-00.xls",
    "tasks_2026-07-04_09-00.xls"
  ]
}
```

Дальше в GitHub Desktop:

1. Summary: `Add Bitrix export 2026-07-04 09-00`.
2. `Commit to main`.
3. `Push origin`.
4. Открой дашборд и нажми `Обновить`.

## 7. Как часто прикладывать выгрузки

Обычный режим:

```text
1 раз в рабочий день утром до 09:30
```

Активная проектная фаза:

```text
2 раза в день: утром до 09:30 и после обеда в 14:00–15:00
```

Критический период перед сдачей:

```text
3 раза в день: утром, в середине дня и в конце рабочего дня
```

Старые выгрузки не удаляй. Они нужны для экрана `Динамика`.
