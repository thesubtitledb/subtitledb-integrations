using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace SubtitleDb.Tests
{
    /// <summary>
    /// plugins/shared/match-cases.json, read the same way the Python, Lua and
    /// TypeScript suites read it. A rule changed in one language and not the others
    /// fails here.
    /// </summary>
    public static class SharedCases
    {
        public static JsonElement Root { get; } = Load();

        public static IEnumerable<object[]> Section(string name)
        {
            foreach (var element in Root.GetProperty(name).EnumerateArray())
            {
                yield return new object[] { new Case(element) };
            }
        }

        private static JsonElement Load()
        {
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (directory != null)
            {
                var path = Path.Combine(directory.FullName, "plugins", "shared", "match-cases.json");
                if (File.Exists(path))
                {
                    return JsonDocument.Parse(File.ReadAllText(path)).RootElement.Clone();
                }

                directory = directory.Parent;
            }

            throw new FileNotFoundException("plugins/shared/match-cases.json is not above " + AppContext.BaseDirectory);
        }
    }

    /// <summary>
    /// One case. Wrapped so xunit prints the "why" instead of a JSON blob, which is
    /// the difference between a failure that names the rule and one that does not.
    /// </summary>
    public sealed class Case
    {
        public Case(JsonElement element)
        {
            Element = element;
        }

        public JsonElement Element { get; }

        public JsonElement? Get(string name)
        {
            return Element.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.Null
                ? value
                : (JsonElement?)null;
        }

        public string? Text(string name) => Get(name)?.GetString();

        public int? Number(string name)
        {
            var value = Get(name);
            return value.HasValue ? value.Value.GetInt32() : (int?)null;
        }

        public double? Real(string name)
        {
            var value = Get(name);
            return value.HasValue ? value.Value.GetDouble() : (double?)null;
        }

        public bool? Flag(string name)
        {
            var value = Get(name);
            return value.HasValue ? value.Value.GetBoolean() : (bool?)null;
        }

        public List<string> Strings(string name)
        {
            var outp = new List<string>();
            var value = Get(name);
            if (value.HasValue)
            {
                foreach (var item in value.Value.EnumerateArray())
                {
                    var text = item.GetString();
                    if (text != null)
                    {
                        outp.Add(text);
                    }
                }
            }

            return outp;
        }

        public override string ToString()
        {
            return Text("why") ?? Text("name") ?? Text("input") ?? Element.ToString();
        }
    }
}
