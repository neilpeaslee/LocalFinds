defmodule Localfinds.Places.ParamsTest do
  use ExUnit.Case, async: true

  alias Localfinds.Places.Params

  # -- area: town XOR bbox ------------------------------------------------
  test "town alone is valid" do
    assert {:ok, %Params{town: "Rockland", bbox: nil}} =
             Params.validate(%{"town" => "Rockland"})
  end

  test "bbox alone is valid and keeps s,w,n,e order as floats" do
    assert {:ok, %Params{bbox: {44.05, -69.20, 44.15, -69.05}, town: nil}} =
             Params.validate(%{"bbox" => "44.05,-69.20,44.15,-69.05"})
  end

  test "both town and bbox is a 400" do
    assert {:error, msg} =
             Params.validate(%{"town" => "Rockland", "bbox" => "44,-69,45,-68"})

    assert msg =~ "exactly one"
  end

  test "neither town nor bbox is a 400" do
    assert {:error, _} = Params.validate(%{})
  end

  test "empty town is a 400" do
    assert {:error, _} = Params.validate(%{"town" => ""})
  end

  # -- bbox malformations --------------------------------------------------
  for bad <- [
        "44,-69,45",            # 3 numbers
        "44,-69,45,-68,0",      # 5 numbers
        "a,b,c,d",              # not numbers
        "45,-69,44,-68",        # s >= n
        "44,-68,45,-69",        # w >= e
        "-91,-69,45,-68",       # s out of range
        "44,-69,91,-68",        # n out of range
        "44,-181,45,-68",       # w out of range
        "44,-69,45,181"         # e out of range
      ] do
    test "bbox #{inspect(bad)} is a 400" do
      assert {:error, msg} = Params.validate(%{"bbox" => unquote(bad)})
      assert msg =~ "bbox"
    end
  end

  # -- keys ------------------------------------------------------------------
  test "keys: valid CSV subset, with whitespace tolerated" do
    assert {:ok, %Params{keys: ["shop", "office"]}} =
             Params.validate(%{"town" => "Rockland", "keys" => "shop, office"})
  end

  test "keys: all six allowed" do
    csv = "amenity,shop,tourism,office,craft,leisure"
    assert {:ok, %Params{keys: keys}} = Params.validate(%{"town" => "t", "keys" => csv})
    assert length(keys) == 6
  end

  test "keys: unknown key is a 400 naming the key" do
    assert {:error, msg} = Params.validate(%{"town" => "t", "keys" => "shop,natural"})
    assert msg =~ "natural"
  end

  test "keys absent means nil (no filter)" do
    assert {:ok, %Params{keys: nil}} = Params.validate(%{"town" => "t"})
  end

  # -- limit -----------------------------------------------------------------
  test "limit defaults to 200" do
    assert {:ok, %Params{limit: 200}} = Params.validate(%{"town" => "t"})
  end

  test "limit parses and passes through" do
    assert {:ok, %Params{limit: 5}} = Params.validate(%{"town" => "t", "limit" => "5"})
  end

  test "limit is capped at 1000, silently (contract: server-capped)" do
    assert {:ok, %Params{limit: 1000}} = Params.validate(%{"town" => "t", "limit" => "2000"})
  end

  for bad <- ["0", "-1", "abc", "1.5"] do
    test "limit #{inspect(bad)} is a 400" do
      assert {:error, msg} = Params.validate(%{"town" => "t", "limit" => unquote(bad)})
      assert msg =~ "limit"
    end
  end
end
